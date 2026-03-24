const fs = require('fs/promises');
const path = require('path');
const { google } = require('googleapis');

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar'];
const DEFAULT_TIME_ZONE = 'America/Chicago';
const DEFAULT_RESERVATION_SOURCE = 'autobay-slack-bot';

class CalendarServiceError extends Error {
  constructor(message, code = 'CALENDAR_ERROR', details = {}) {
    super(message);
    this.name = 'CalendarServiceError';
    this.code = code;
    this.details = details;
  }
}

class CalendarService {
  constructor(calendars, options = {}) {
    if (!Array.isArray(calendars) || calendars.length === 0) {
      throw new Error('CalendarService requires at least one Autobay calendar.');
    }

    this.calendars = calendars.map(calendar => ({
      ...calendar,
      normalizedName: this.normalizeBayName(calendar.name)
    }));

    this.options = {
      credentialsPath: options.credentialsPath || path.resolve(process.cwd(), 'client_secret.json'),
      tokenPath: options.tokenPath || path.resolve(process.cwd(), 'token.json'),
      credentialsJson: options.credentialsJson || process.env.GOOGLE_CLIENT_SECRET_JSON || null,
      tokenJson: options.tokenJson || process.env.GOOGLE_TOKEN_JSON || null,
      serviceAccountKeyFile:
        options.serviceAccountKeyFile || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || null,
      serviceAccountJson:
        options.serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null,
      delegatedUser: options.delegatedUser || process.env.GOOGLE_IMPERSONATED_USER || null,
      timeZone: options.timeZone || DEFAULT_TIME_ZONE,
      maxRetryAttempts: options.maxRetryAttempts || 4,
      reservationSource: options.reservationSource || DEFAULT_RESERVATION_SOURCE,
      conflictSearchWindowDays: options.conflictSearchWindowDays || 30
    };

    this.authPromise = null;
    this.calendarApiPromise = null;
  }

  getBayNames() {
    return this.calendars.map(calendar => calendar.name);
  }

  async getAutobayStatuses(referenceTime = new Date()) {
    const statusPromises = this.calendars.map(calendar =>
      this.getAutobayStatus(calendar.name, referenceTime)
    );

    return Promise.all(statusPromises);
  }

  async getAutobayStatus(bayName, referenceTime = new Date()) {
    const bay = this.getBayOrThrow(bayName);
    const events = await this.listEvents(bay.id, {
      timeMin: referenceTime.toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const activeEvent = events.find(event => this.isActive(event, referenceTime));

    if (activeEvent) {
      return {
        bayName: bay.name,
        state: 'OCCUPIED',
        currentEvent: activeEvent,
        until: activeEvent.end
      };
    }

    const nextEvent = events.find(event => event.start >= referenceTime) || null;

    if (!nextEvent) {
      return {
        bayName: bay.name,
        state: 'FREE',
        freeUntil: null,
        availableForMs: null
      };
    }

    return {
      bayName: bay.name,
      state: 'FREE',
      nextEvent,
      freeUntil: nextEvent.start,
      availableForMs: nextEvent.start.getTime() - referenceTime.getTime()
    };
  }

  async getUpcomingReservations({ bayName, startTime, endTime, maxResults = 50 }) {
    if (!(startTime instanceof Date) || Number.isNaN(startTime.getTime())) {
      throw new CalendarServiceError('A valid start time is required.', 'INVALID_DATE');
    }

    if (!(endTime instanceof Date) || Number.isNaN(endTime.getTime())) {
      throw new CalendarServiceError('A valid end time is required.', 'INVALID_DATE');
    }

    if (endTime <= startTime) {
      throw new CalendarServiceError('The end time must be after the start time.', 'INVALID_DATE');
    }

    const bay = this.getBayOrThrow(bayName);
    const reservations = await this.listEvents(bay.id, {
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    });

    return {
      bayName: bay.name,
      reservations
    };
  }

  async bookBay({ bayName, durationMinutes, slackUserId, slackUserName, startTime = new Date() }) {
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 600) {
      throw new CalendarServiceError(
        'Duration must be a whole number between 1 and 600 minutes.',
        'INVALID_DURATION'
      );
    }

    if (!slackUserId) {
      throw new CalendarServiceError('A Slack user id is required to create a booking.', 'INVALID_USER');
    }

    const bay = this.getBayOrThrow(bayName);
    const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

    const blockingEvent = await this.findBlockingEvent(bay.id, startTime, endTime);

    if (blockingEvent) {
      const nextAvailableStart = await this.findNextAvailableStart(bay.id, startTime);

      throw new CalendarServiceError('The requested Autobay slot is not available.', 'BOOKING_CONFLICT', {
        bayName: bay.name,
        blockingEvent,
        blockingOwnerName: this.getEventOwnerName(blockingEvent),
        nextAvailableStart
      });
    }

    const resource = {
      summary: `Reserved by ${slackUserName || slackUserId}`,
      description: [
        `Reserved by ${slackUserName || slackUserId}`,
        `Slack user id: ${slackUserId}`,
        `Created by Autobay Slack bot`
      ].join('\n'),
      start: {
        dateTime: startTime.toISOString(),
        timeZone: this.options.timeZone
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: this.options.timeZone
      },
      extendedProperties: {
        private: {
          reservation_source: this.options.reservationSource,
          slack_user_id: slackUserId,
          slack_user_name: slackUserName || slackUserId
        }
      }
    };

    let createdEvent;

    try {
      createdEvent = await this.insertEvent(bay.id, resource);
    } catch (error) {
      if (this.isConflictError(error)) {
        const freshBlockingEvent = await this.findBlockingEvent(bay.id, startTime, endTime);
        const nextAvailableStart = await this.findNextAvailableStart(bay.id, startTime);

        throw new CalendarServiceError('The requested Autobay slot is no longer available.', 'BOOKING_CONFLICT', {
          bayName: bay.name,
          blockingEvent: freshBlockingEvent,
          blockingOwnerName: freshBlockingEvent ? this.getEventOwnerName(freshBlockingEvent) : 'Unknown',
          nextAvailableStart
        });
      }

      throw error;
    }

    const raceConflict = await this.detectRaceConflict(bay.id, createdEvent);

    if (raceConflict) {
      await this.safeDeleteEvent(bay.id, createdEvent.id);

      const nextAvailableStart = await this.findNextAvailableStart(bay.id, startTime);

      throw new CalendarServiceError(
        'Another reservation was created for the same window at the same time.',
        'BOOKING_CONFLICT',
        {
          bayName: bay.name,
          blockingEvent: raceConflict,
          blockingOwnerName: this.getEventOwnerName(raceConflict),
          nextAvailableStart
        }
      );
    }

    return {
      bayName: bay.name,
      startTime,
      endTime,
      event: createdEvent
    };
  }

  async cancelBooking({ bayName, slackUserId }) {
    if (!slackUserId) {
      throw new CalendarServiceError('A Slack user id is required to cancel a booking.', 'INVALID_USER');
    }

    const bay = this.getBayOrThrow(bayName);
    const now = new Date();
    const ownedReservations = await this.listEvents(bay.id, {
      timeMin: now.toISOString(),
      maxResults: 25,
      singleEvents: true,
      orderBy: 'startTime',
      privateExtendedProperty: [
        `reservation_source=${this.options.reservationSource}`,
        `slack_user_id=${slackUserId}`
      ]
    });

    const reservationToCancel =
      ownedReservations.find(event => this.isActive(event, now)) || ownedReservations[0] || null;

    if (!reservationToCancel) {
      throw new CalendarServiceError(
        `No active or upcoming booking was found for ${bay.name} under your Slack account.`,
        'BOOKING_NOT_FOUND',
        { bayName: bay.name }
      );
    }

    await this.deleteEvent(bay.id, reservationToCancel.id);

    return {
      bayName: bay.name,
      event: reservationToCancel
    };
  }

  getEventOwnerName(event) {
    if (!event) {
      return 'Unknown';
    }

    if (event.extendedProperties.private.slack_user_name) {
      return event.extendedProperties.private.slack_user_name;
    }

    if (event.summary && event.summary.startsWith('Reserved by ')) {
      return event.summary.replace(/^Reserved by /i, '').trim();
    }

    return (
      event.creator.displayName ||
      event.organizer.displayName ||
      event.creator.email ||
      event.organizer.email ||
      event.summary ||
      'Unknown'
    );
  }

  normalizeBayName(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
  }

  getBayOrThrow(bayName) {
    const normalized = this.normalizeBayName(bayName);
    const bay = this.calendars.find(calendar => calendar.normalizedName === normalized);

    if (!bay) {
      throw new CalendarServiceError(
        `Unknown Autobay "${bayName}". Available bays: ${this.getBayNames().join(', ')}`,
        'BAY_NOT_FOUND',
        { availableBays: this.getBayNames() }
      );
    }

    return bay;
  }

  async getCalendarApi() {
    if (!this.calendarApiPromise) {
      this.calendarApiPromise = this.getAuthClient().then(auth =>
        google.calendar({
          version: 'v3',
          auth
        })
      );
    }

    return this.calendarApiPromise;
  }

  async getAuthClient() {
    if (!this.authPromise) {
      this.authPromise = this.options.serviceAccountKeyFile
        ? this.createJwtClient()
        : this.createOAuthClient();
    }

    return this.authPromise;
  }

  async createOAuthClient() {
    const [credentialsRaw, tokenRaw] = await Promise.all([
      this.options.credentialsJson
        ? Promise.resolve(this.options.credentialsJson)
        : fs.readFile(this.options.credentialsPath, 'utf8'),
      this.options.tokenJson
        ? Promise.resolve(this.options.tokenJson)
        : fs.readFile(this.options.tokenPath, 'utf8')
    ]);

    const credentials = JSON.parse(credentialsRaw);
    const clientCredentials = credentials.installed || credentials.web;

    if (!clientCredentials) {
      throw new Error('client_secret.json must contain an "installed" or "web" credential block.');
    }

    const auth = new google.auth.OAuth2(
      clientCredentials.client_id,
      clientCredentials.client_secret,
      clientCredentials.redirect_uris[0]
    );

    auth.setCredentials(JSON.parse(tokenRaw));

    return auth;
  }

  async createJwtClient() {
    const serviceAccountRaw = this.options.serviceAccountJson
      ? this.options.serviceAccountJson
      : await fs.readFile(path.resolve(this.options.serviceAccountKeyFile), 'utf8');
    const serviceAccount = JSON.parse(serviceAccountRaw);

    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: CALENDAR_SCOPES,
      subject: this.options.delegatedUser || undefined
    });

    await auth.authorize();

    return auth;
  }

  async listEvents(calendarId, params = {}) {
    const calendarApi = await this.getCalendarApi();

    const response = await this.withRetry(() =>
      calendarApi.events.list({
        calendarId,
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: this.options.timeZone,
        ...params
      })
    );

    return (response.data.items || [])
      .map(item => this.toEvent(item))
      .filter(event => event.status !== 'cancelled');
  }

  async insertEvent(calendarId, resource) {
    const calendarApi = await this.getCalendarApi();

    const response = await this.withRetry(() =>
      calendarApi.events.insert({
        calendarId,
        resource,
        sendUpdates: 'none'
      })
    );

    return this.toEvent(response.data);
  }

  async deleteEvent(calendarId, eventId) {
    const calendarApi = await this.getCalendarApi();

    await this.withRetry(() =>
      calendarApi.events.delete({
        calendarId,
        eventId,
        sendUpdates: 'none'
      })
    );
  }

  async safeDeleteEvent(calendarId, eventId) {
    try {
      await this.deleteEvent(calendarId, eventId);
    } catch (error) {
      if (!this.isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async findBlockingEvent(calendarId, startTime, endTime) {
    const events = await this.listEvents(calendarId, {
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime'
    });

    return events.find(event => this.eventsOverlap(event, { start: startTime, end: endTime })) || null;
  }

  async detectRaceConflict(calendarId, createdEvent) {
    const overlappingEvents = await this.listEvents(calendarId, {
      timeMin: createdEvent.start.toISOString(),
      timeMax: createdEvent.end.toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const conflictingEvents = overlappingEvents
      .filter(event => event.id !== createdEvent.id)
      .filter(event => this.eventsOverlap(event, createdEvent))
      .sort((left, right) => {
        const leftCreated = left.created ? left.created.getTime() : 0;
        const rightCreated = right.created ? right.created.getTime() : 0;

        if (leftCreated !== rightCreated) {
          return leftCreated - rightCreated;
        }

        return String(left.id).localeCompare(String(right.id));
      });

    const winningConflict = conflictingEvents[0];

    if (!winningConflict) {
      return null;
    }

    const createdEventTimestamp = createdEvent.created ? createdEvent.created.getTime() : Number.MAX_SAFE_INTEGER;
    const winningTimestamp = winningConflict.created ? winningConflict.created.getTime() : 0;

    if (winningTimestamp < createdEventTimestamp) {
      return winningConflict;
    }

    if (winningTimestamp === createdEventTimestamp && String(winningConflict.id) < String(createdEvent.id)) {
      return winningConflict;
    }

    return null;
  }

  async findNextAvailableStart(calendarId, searchStart) {
    const searchEnd = new Date(
      searchStart.getTime() + this.options.conflictSearchWindowDays * 24 * 60 * 60 * 1000
    );

    const upcomingEvents = await this.listEvents(calendarId, {
      timeMin: searchStart.toISOString(),
      timeMax: searchEnd.toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime'
    });

    let candidate = new Date(searchStart);

    for (const event of upcomingEvents) {
      if (event.end <= candidate) {
        continue;
      }

      if (event.start > candidate) {
        break;
      }

      candidate = new Date(Math.max(candidate.getTime(), event.end.getTime()));
    }

    return candidate;
  }

  eventsOverlap(left, right) {
    return left.start < right.end && left.end > right.start;
  }

  isActive(event, referenceTime) {
    return event.start <= referenceTime && event.end > referenceTime;
  }

  toEvent(item) {
    return {
      id: item.id,
      summary: item.summary || 'Busy',
      description: item.description || '',
      status: item.status || 'confirmed',
      htmlLink: item.htmlLink || null,
      visibility: item.visibility || 'default',
      start: new Date(item.start.dateTime || item.start.date),
      end: new Date(item.end.dateTime || item.end.date),
      created: item.created ? new Date(item.created) : null,
      updated: item.updated ? new Date(item.updated) : null,
      creator: {
        displayName: item.creator ? item.creator.displayName || null : null,
        email: item.creator ? item.creator.email || null : null
      },
      organizer: {
        displayName: item.organizer ? item.organizer.displayName || null : null,
        email: item.organizer ? item.organizer.email || null : null
      },
      extendedProperties: {
        private: (item.extendedProperties && item.extendedProperties.private) || {}
      }
    };
  }

  async withRetry(operation, attempt = 0) {
    try {
      return await operation();
    } catch (error) {
      const statusCode = this.getErrorStatusCode(error);
      const reason = this.getErrorReason(error);
      const shouldRetry =
        attempt < this.options.maxRetryAttempts &&
        (statusCode === 409 ||
          statusCode === 412 ||
          statusCode === 429 ||
          statusCode === 500 ||
          statusCode === 502 ||
          statusCode === 503 ||
          statusCode === 504 ||
          reason === 'rateLimitExceeded' ||
          reason === 'userRateLimitExceeded' ||
          reason === 'backendError');

      if (!shouldRetry) {
        if (statusCode === 403 && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
          throw new CalendarServiceError(
            'Google Calendar rate limit exceeded. Please try again in a few seconds.',
            'RATE_LIMITED',
            { cause: error }
          );
        }

        throw this.wrapGoogleError(error);
      }

      const waitTimeMs = Math.min(2000 * 2 ** attempt, 10000);
      await new Promise(resolve => setTimeout(resolve, waitTimeMs));
      return this.withRetry(operation, attempt + 1);
    }
  }

  wrapGoogleError(error) {
    if (error instanceof CalendarServiceError) {
      return error;
    }

    return new CalendarServiceError(
      `Google Calendar request failed: ${error.message || 'Unknown error'}`,
      'GOOGLE_API_ERROR',
      { cause: error }
    );
  }

  getErrorStatusCode(error) {
    return error.code || (error.response && error.response.status) || null;
  }

  getErrorReason(error) {
    return (
      (error.errors && error.errors[0] && error.errors[0].reason) ||
      (error.response &&
        error.response.data &&
        error.response.data.error &&
        error.response.data.error.errors &&
        error.response.data.error.errors[0] &&
        error.response.data.error.errors[0].reason) ||
      null
    );
  }

  isConflictError(error) {
    const statusCode = this.getErrorStatusCode(error);
    return statusCode === 409 || statusCode === 412;
  }

  isNotFoundError(error) {
    return this.getErrorStatusCode(error) === 404;
  }
}

module.exports = {
  CalendarService,
  CalendarServiceError
};
