// © 2020 Niccolò Zapponi
// SimpliSafe 3 API Wrapper

import axios from 'axios';
import io from 'socket.io-client';
import fs from 'fs';
import path from 'path';

// Do not touch these - they allow the client to make requests to the SimpliSafe API
const clientUuid = '4df55627-46b2-4e2c-866b-1521b395ded2';
const clientUsername = `${clientUuid}.WebApp.simplisafe.com`;
const clientPassword = '';

const subscriptionCacheTime = 3000; // ms
const sensorCacheTime = 3000; // ms
const internalConfigFileName = 'simplisafe3config.json';
const mfaTimeout = 5 * 60 * 1000; // ms
const rateLimitInitialInterval = 60000; // ms
const rateLimitMaxInterval = 2 * 60 * 60 * 1000; // ms
const sensorRefreshLockoutDuration = 15000; // ms
const errorSuppressionDuration = 5 * 60 * 1000; // ms

const ssApi = axios.create({
    baseURL: 'https://api.simplisafe.com/v1'
});

const validAlarmStates = [
    'off',
    'home',
    'away'
];

const validLockStates = [
    'lock',
    'unlock'
];

export const SENSOR_TYPES = {
	'UNKNOWN' : -1,
    'APP': 0,
    'KEYPAD': 1,
    'KEYCHAIN': 2,
    'PANIC_BUTTON': 3,
    'MOTION_SENSOR': 4,
    'ENTRY_SENSOR': 5,
    'GLASSBREAK_SENSOR': 6,
    'CO_SENSOR': 7,
    'SMOKE_SENSOR': 8,
    'WATER_SENSOR': 9,
    'FREEZE_SENSOR': 10,
    'SIREN': 11,
    'SIREN_2': 13,
    'DOORLOCK': 16,
  	'PINPAD': 100,
    'DOORLOCK_2': 253
};

export const EVENT_TYPES = {
    ALARM_TRIGGER: 'ALARM_TRIGGER',
    ALARM_OFF: 'ALARM_OFF',
    ALARM_DISARM: 'ALARM_DISARM',
    ALARM_CANCEL: 'ALARM_CANCEL',
    HOME_EXIT_DELAY: 'HOME_EXIT_DELAY',
    HOME_ARM: 'HOME_ARM',
    AWAY_EXIT_DELAY: 'AWAY_EXIT_DELAY',
    AWAY_ARM: 'AWAY_ARM',
    MOTION: 'MOTION',
    ENTRY: 'ENTRY',
    CAMERA_MOTION: 'CAMERA_MOTION',
    DOORBELL: 'DOORBELL',
    DOORLOCK_LOCKED: 'DOORLOCK_LOCKED',
    DOORLOCK_UNLOCKED: 'DOORLOCK_UNLOCKED',
    DOORLOCK_ERROR: 'DOORLOCK_ERROR',
    CONNECTED: 'CONNECTED',
    DISCONNECT: 'DISCONNECT',
    CONNECTION_LOST: 'CONNECTION_LOST'
};

export class RateLimitError extends Error {
    constructor(...params) {
        super(...params);
        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, RateLimitError);
        }
        this.name = 'RateLimitError';
    }
}

export const SOCKET_RETRY_INTERVAL = 1000; //ms

const generateSimplisafeId = () => {
    const supportedCharacters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789';
    let id = [];
    while (id.length < 10) {
        id.push(supportedCharacters[Math.floor(Math.random() * supportedCharacters.length)]);
    }

    id = id.join('');

    return `${id.substring(0, 5)}-${id.substring(5)}`;
};

class SimpliSafe3 {

    token;
    rToken;
    tokenType;
    expiry;
    username;
    password;
    userId;
    subId;
    accountNumber;
    socket;
    lastSubscriptionRequests = {};
    lastSensorRequest;
    lastLockRequest;
    sensorRefreshInterval;
    sensorRefreshTime;
    sensorRefreshLockoutTimeout;
    sensorRefreshLockoutEnabled = false;
    sensorSubscriptions = [];
    errorSupperessionTimeout;
    nSuppressedErrors;
    ssId;
    storagePath;

    isBlocked;
    nextBlockInterval = rateLimitInitialInterval;
    nextAttempt = 0;
    loginAttempt;
    version;

    constructor(sensorRefreshTime = 15000, resetConfig = false, storagePath, log, debug, version = 3) {
        this.sensorRefreshTime = sensorRefreshTime;
        this.log = log || console.log;
        this.debug = debug;
        this.storagePath = storagePath;
        this.version = version;

        let internalConfigFile = path.join(this.storagePath, internalConfigFileName);
        if (fs.existsSync(internalConfigFile) && resetConfig) {
            fs.unlinkSync(internalConfigFile);
        }

        // Load IDs from internal config file
        if (fs.existsSync(internalConfigFile)) {
            let configFile = fs.readFileSync(internalConfigFile);
            let config = JSON.parse(configFile);
            this.ssId = config.ssId;
        } else {
            this.ssId = generateSimplisafeId();

            try {
                fs.writeFileSync(internalConfigFile, JSON.stringify({
                    ssId: this.ssId
                }));
            } catch (err) {
                this.log.warn('Warning: could not save SS config file. SS-ID will vary');
            }
        }
    }

    async login(username, password, storeCredentials = false) {

        if (storeCredentials) {
            this.username = username;
            this.password = password;
        }

        if (this.isBlocked && Date.now() < this.nextAttempt) {
            let err = new RateLimitError('Login request blocked (rate limit).');
            throw err;
        }

        try {
            const response = await ssApi.post('/api/token', {
                username: username,
                password: password,
                grant_type: 'password',
                client_id: clientUsername,
                device_id: `Homebridge; useragent="Homebridge-SimpliSafe3 (SS-ID: ${this.ssId})"; uuid="${this.clientUuid}"; id="${this.ssId}"`,
                scope: ''
            }, {
                auth: {
                    username: clientUsername,
                    password: clientPassword
                }
            });

            let data = response.data;
            this._storeLogin(data);
            this._resetRateLimitHandler();
        } catch (err) {

            if (err.response) {
                let errCode = err.response.status;
                let errData = err.response.data;

                if (errCode == 403 && (errData && errData.error && errData.error == 'mfa_required')) {

                    this.log.warn('Multifactor authentication required. Check your email and approve the request!');

                    // Multifactor Authentication required
                    let mfaToken = errData.mfa_token;
                    try {
                        let mfaResponse = await ssApi.post('/api/mfa/challenge', {
                            challenge_type: 'oob',
                            client_id: clientUsername,
                            mfa_token: mfaToken
                        });

                        let oobCode = mfaResponse.data.oob_code;
                        let interval = mfaResponse.data.interval * 1000;

                        let tokenData = await this.checkMultifactorAuthentication(mfaToken, oobCode, interval);
                        this._storeLogin(tokenData);
                        this._resetRateLimitHandler();

                    } catch (err) {
                        this.logout(storeCredentials);
                        throw err.response ? err.response : err;
                    }

                } else if (errCode == 403 && errData.error_description !== 'INVALID_CREDENTIALS_PASSWORD') {
                    this._setRateLimitHandler();
                    if (this.debug) this.log.error('SSAPI login received a response error with code 403:', err.response);
                    let err = new RateLimitError('SSAPI login failed, request blocked (rate limit?).');
                    throw err;
                } else {
                    this.logout(storeCredentials);
                    throw errData.error_description == 'INVALID_CREDENTIALS_PASSWORD' ? errData : err.response;
                }
            } else {
                this._setRateLimitHandler();
                let err = new RateLimitError('SSAPI login failed, request blocked (connectivity?).');
                throw err;
            }
        }
    }

    async checkMultifactorAuthentication(mfaToken, oob, interval) {
        const timeLimit = Date.now() + mfaTimeout;

        const intervalChecker = new Promise((resolve, reject) => {
            const mfaInterval = setInterval(async () => {

                if (Date.now() > timeLimit) {
                    clearInterval(mfaInterval);
                    reject();
                }

                let response = await ssApi.post('/api/token', {
                    grant_type: 'http://simplisafe.com/oauth/grant-type/mfa-oob',
                    client_id: clientUsername,
                    mfa_token: mfaToken,
                    oob_code: oob
                });

                let data = response.data;
                if (data.access_token) {
                    clearInterval(mfaInterval);
                    resolve(data);
                }

            }, interval);
        });

        return intervalChecker;
    }

    _resetRateLimitHandler() {
        this.isBlocked = false;
        this.nextBlockInterval = rateLimitInitialInterval;
    }

    _setRateLimitHandler() {
        this.isBlocked = true;
        this.nextAttempt = Date.now() + this.nextBlockInterval;
        if (this.nextBlockInterval < rateLimitMaxInterval) {
            this.nextBlockInterval = this.nextBlockInterval * 2;
        }
    }

    _storeLogin(tokenResponse) {
        this.token = tokenResponse.access_token;
        this.rToken = tokenResponse.refresh_token;
        this.tokenType = tokenResponse.token_type;
        this.expiry = Date.now() + (tokenResponse.expires_in * 1000);
    }

    logout(keepCredentials = false) {
        this.token = null;
        this.rToken = null;
        this.tokenType = null;
        this.expiry = null;
        if (!keepCredentials) {
            this.username = null;
            this.password = null;
        }
    }

    isLoggedIn() {
        return this.rToken !== null || (this.token !== null && Date.now() < this.expiry);
    }

    async refreshToken() {
        if (!this.isLoggedIn() || !this.rToken) {
            let err = new Error('User is not logged in');
            throw err;
        }

        if (this.isBlocked && Date.now() < this.nextAttempt) {
            let err = new RateLimitError('Refresh token request blocked (rate limit).');
            throw err;
        }

        try {
            const response = await ssApi.post('/api/token', {
                refresh_token: this.rToken,
                grant_type: 'refresh_token'
            }, {
                auth: {
                    username: clientUsername,
                    password: clientPassword
                }
            });

            let data = response.data;
            this._storeLogin(data);
            this._resetRateLimitHandler();

        } catch (err) {

            if (err.response) {
                let errCode = err.response.status;

                if (errCode == 403) {
                    this.log.error('SSAPI token refresh failed, request blocked (rate limit?).');
                    this._setRateLimitHandler();
                } else {
                    this.logout(this.username != null);
                }
                throw err.response;
            } else {
                this._setRateLimitHandler();
                let err = new RateLimitError('SSAPI login failed, request blocked (connectivity?).');
                throw err;
            }
        }
    }

    async request(params, tokenRefreshed = false) {
        if (this.isBlocked && Date.now() < this.nextAttempt) {
            let err = new RateLimitError('Blocking request: rate limited');
            throw err;
        }

        if (!this.isLoggedIn()) {
            if (this.isBlocked) {
                // User is not logged in due to the last login attempt being blocked.
                // It's now time to try logging in again.

                // Use this logic so that if multiple requests happen at the same time,
                // only one will attempt to log in.
                if (!this.loginAttempt) {
                    this.loginAttempt = this.login(this.username, this.password, true);
                }
                await this.loginAttempt;
                this.loginAttempt = null;
            } else {
                let err = new Error('User is not logged in');
                throw err;
            }
        }

        try {
            const response = await ssApi.request({
                ...params,
                headers: {
                    ...params.headers,
                    Authorization: `${this.tokenType} ${this.token}`
                }
            });
            this._resetRateLimitHandler();
            return response.data;
        } catch (err) {
            if (!err.response) {
                let rateLimitError = new RateLimitError(err);
                throw rateLimitError;
            }

            let statusCode = err.response.status;
            if (statusCode == 401 && !tokenRefreshed) {
                return this.refreshToken()
                    .then(() => {
                        return this.request(params, true);
                    })
                    .catch(async err => {
                        let statusCode = err.status;
                        if ((statusCode == 401 || statusCode == 403) && this.username && this.password) {
                            await this.login(this.username, this.password, true);
                            return this.request(params, true);
                        } else {
                            throw err;
                        }
                    });
            } else if (statusCode == 403) {
                this.log.error('SSAPI request failed, request blocked (rate limit?).');
                if (this.debug) this.log.error('SSAPI request received a response error with code 403:', err.response);
                this._setRateLimitHandler();
                throw new RateLimitError(err.response.data);
            } else {
                throw err.response.data;
            }
        }
    }

    async getUserId() {
        if (this.userId) {
            return this.userId;
        }

        let data = await this.request({
            method: 'GET',
            url: '/api/authCheck'
        });
        this.userId = data.userId;
        return this.userId;
    }

    async getUserInfo() {
        let userId = await this.getUserId();

        let data = await this.request({
            method: 'GET',
            url: `/users/${userId}/loginInfo`
        });

        return data.loginInfo;
    }

    async getSubscriptions() {
        let userId = await this.getUserId();
        let data = await this.request({
            method: 'GET',
            url: `/users/${userId}/subscriptions?activeOnly=false`
        });

        let subscriptions = data.subscriptions.filter(s => s.sStatus === 10 || s.sStatus === 20);

        if (this.accountNumber) {
            subscriptions = subscriptions.filter(s => s.location.account === this.accountNumber);
        }

        if (subscriptions.length == 1) {
            this.subId = subscriptions[0].sid;
        }

        return subscriptions;
    }

    async getSubscription(subId = null, forceRefresh = false) {
        let subscriptionId = subId;

        if (!subscriptionId) {
            subscriptionId = this.subId;

            if (!subscriptionId) {
                let subs = await this.getSubscriptions();
                if (subs.length == 1) {
                    subscriptionId = subs[0].sid;
                } else if (subs.length == 0) {
                    throw new Error('No matching subscriptions found. Check your account and ensure you have an active subscription.');
                } else {
                    let accountNumbers = subs.map(s => s.location.account);
                    throw new Error(`Multiple subscriptions found. Edit your config.json file and add a parameter called "subscriptionId": "YOUR ACCOUNT NUMBER". The account numbers found were: ${accountNumbers.join(', ')}.`);
                }
            }
        }

        if (forceRefresh || !this.lastSubscriptionRequests[subscriptionId]) {
            this.lastSubscriptionRequests[subscriptionId] = this.request({
                method: 'GET',
                url: `/subscriptions/${subscriptionId}/`
            })
                .then(sub => {
                    return sub;
                })
                .catch(err => {
                    throw err;
                })
                .finally(() => {
                    setTimeout(() => {
                        this.lastSubscriptionRequests[subscriptionId] = null;
                    }, subscriptionCacheTime);
                });
        }

        let data = await this.lastSubscriptionRequests[subscriptionId];
        return data.subscription;
    }

    setDefaultSubscription(accountNumber) {
        if (!accountNumber) {
            throw new Error('Account Number not defined');
        }

        this.accountNumber = accountNumber;
    }

    async getAlarmState(forceRefresh = false, retry = false) {
        let subscription = await this.getSubscription(null, forceRefresh);

        if (subscription.location && subscription.location.system) {
            if (subscription.location.system.isAlarming) {
                return 'ALARM';
            }

            const validStates = ['OFF', 'HOME', 'AWAY', 'AWAY_COUNT', 'HOME_COUNT', 'ALARM_COUNT', 'ALARM'];
            let alarmState = subscription.location.system.alarmState.toUpperCase();
            if (!validStates.includes(alarmState)) {
                if (!retry) {
                    let retriedState = await this.getAlarmState(true, true);
                    return retriedState;
                } else {
                    throw new Error('Alarm state not understood');
                }
            }

            return alarmState;
        } else {
            throw new Error('Subscription format not understood');
        }
    }

    async setAlarmState(newState) {
        let state = newState.toLowerCase();

        if (validAlarmStates.indexOf(state) == -1) {
            throw new Error('Invalid target state');
        }

        if (!this.subId) {
            await this.getSubscription();
        }

		let url = `/ss3/subscriptions/${this.subId}/state/${state}`;
		if (this.version == 2) {
			url = `/subscriptions/${this.subId}/state?state=${state}`;
		}
	
        let data = await this.request({
            method: 'POST',
		  url: url
        });
        this.handleSensorRefreshLockout();
        return data;
    }

    async getEvents(params) {

        if (!this.subId) {
            await this.getSubscription();
        }

        let url = `/subscriptions/${this.subId}/events`;
        if (Object.keys(params).length > 0) {
            let query = Object.keys(params).map(key => `${key}=${params[key]}`);
            url = `${url}?${query.join('&')}`;
        }

        let data = await this.request({
            method: 'GET',
            url: url
        });

        let events = data.events;
        return events;
    }

    async getSensors(forceUpdate = false, forceRefresh = false) {

        if (!this.subId) {
            await this.getSubscription();
        }

        if (forceRefresh || !this.lastSensorRequest) {
		  let url = `/ss3/subscriptions/${this.subId}/sensors?forceUpdate=${forceUpdate ? 'true' : 'false'}`;
		  if (this.version == 2) {
			url = `/subscriptions/${this.subId}/settings?cached=${forceUpdate ? 'true' : 'false'}&settingsType=sensors`;
		  }
            this.lastSensorRequest = this.request({
                method: 'GET',
				url: url
			}).then(data => {
                    return data;
                })
                .catch(err => {
                    throw err;
                })
                .finally(() => {
                    setTimeout(() => {
                        this.lastSensorRequest = null;
                    }, sensorCacheTime);
                });
        }

        let data = await this.lastSensorRequest;
		if (this.version == 2) {
			return data.settings.sensors;
		}
		else
        return data.sensors;
    }

    async getCameras(forceRefresh = false) {
        let subscription = await this.getSubscription(null, forceRefresh);

        if (subscription.location && subscription.location.system && subscription.location.system.cameras) {
            return subscription.location.system.cameras;
        } else {
            throw new Error('Subscription format not understood');
        }
    }

    async getLocks(forceRefresh) {
        if (!this.subId) {
            await this.getSubscription();
        }

        if (forceRefresh || !this.lastLockRequest) {
            this.lastLockRequest = this.request({
                method: 'GET',
                url: `/doorlock/${this.subId}`
            })
                .then(data => {
                    return data;
                })
                .catch(err => {
                    throw err;
                })
                .finally(() => {
                    setTimeout(() => {
                        this.lastLockRequest = null;
                    }, sensorCacheTime);
                });
        }

        let data = await this.lastLockRequest;
        this.sensorRefreshLockoutEnabled = data.length > 0;
        return data;

    }

    async setLockState(lockId, newState) {
        let state = newState.toLowerCase();

        if (validLockStates.indexOf(state) == -1) {
            throw new Error('Invalid target state');
        }

        if (!this.subId) {
            await this.getSubscription();
        }

        let data = await this.request({
            method: 'POST',
            url: `/doorlock/${this.subId}/${lockId}/state`,
            data: {
                state: state
            }
        });
        return data;
    }

    async subscribeToEvents(callback) {

        let _socketCallback = data => {
            if (data.sid != this.subId) {
                // Ignore event as it doesn't relate to this account
                return;
            }

            switch (data.eventType) {
                case 'alarm':
                    callback(EVENT_TYPES.ALARM_TRIGGER, data);
                    break;
                case 'alarmCancel':
                    callback(EVENT_TYPES.ALARM_OFF, data);
                    break;
                case 'activity':
                case 'activityQuiet':
                default:
                    // if it's not an alarm event, check by eventCid
                    switch (data.eventCid) {
                        case 1400:
                        case 1407:
                            // 1400 is disarmed with Master PIN, 1407 is disarmed with Remote
                            callback(EVENT_TYPES.ALARM_DISARM, data);
                            this.handleSensorRefreshLockout();
                            break;
                        case 1406:
                            callback(EVENT_TYPES.ALARM_CANCEL, data);
                            this.handleSensorRefreshLockout();
                            break;
                        case 1409:
                            callback(EVENT_TYPES.MOTION, data);
                            break;
                        case 9441:
                            callback(EVENT_TYPES.HOME_EXIT_DELAY, data);
                            break;
                        case 3441:
                        case 3491:
                            callback(EVENT_TYPES.HOME_ARM, data);
                            this.handleSensorRefreshLockout();
                            break;
                        case 9401:
                        case 9407:
                            // 9401 is for Keypad, 9407 is for Remote
                            callback(EVENT_TYPES.AWAY_EXIT_DELAY, data);
                            break;
                        case 3401:
                        case 3407:
                        case 3487:
                        case 3481:
                            // 3401 is for Keypad, 3407 is for Remote
                            callback(EVENT_TYPES.AWAY_ARM, data);
                            this.handleSensorRefreshLockout();
                            break;
                        case 1429:
                            callback(EVENT_TYPES.ENTRY, data);
                            break;
                        case 1110:
                        case 1154:
                        case 1159:
                        case 1162:
                        case 1132:
                        case 1134:
                        case 1120:
                            callback(EVENT_TYPES.ALARM_TRIGGER, data);
                            break;
                        case 1170:
                            callback(EVENT_TYPES.CAMERA_MOTION, data);
                            break;
                        case 1458:
                            callback(EVENT_TYPES.DOORBELL, data);
                            break;
                        case 9700:
                            callback(EVENT_TYPES.DOORLOCK_UNLOCKED, data);
                            break;
                        case 9701:
                            callback(EVENT_TYPES.DOORLOCK_LOCKED, data);
                            break;
                        case 9703:
                            callback(EVENT_TYPES.DOORLOCK_ERROR, data);
                            break;
						case 1601:
						  if (this.debug) this.log.debug('Test Signal Received:', data);
						  break;			
                        case 1602:
                            // Automatic test
                            break;
              
						case 1604:
							if (this.debug) this.log.debug('Sensor Test Received:', data);
							break;
			  
						case 3110:
						case 3154:
						case 3159:
						case 3162:
							// Alarm stopped (smoke, water, freeze, CO)
							this.log.warn('Alarm stopped');
							break;
			
						case 1301:
							this.log.warn('Power outage!');
							break;
			
						case 3301:
							this.log.warn('Power restored');
							break;
				
						case 1344:
							this.log.warn('system Interference Detected');
							break;
				
						case 3344:
							this.log.warn('system Interference Resolved');
							break;

                        default:
                            // Unknown event
                            if (this.debug) this.log.debug('Unknown SSAPI event:', data);
                            callback(null, data);
                            break;
                    }
                    break;
            }
        };

        if (this.isBlocked && Date.now() < this.nextAttempt) {
            let err = new RateLimitError('Login request blocked (rate limit).');
            throw err;
        }

        if (!this.socket) {
            let userId = await this.getUserId();

            this.socket = io(`https://api.simplisafe.com/v1/user/${userId}`, {
                path: '/socket.io',
                query: {
                    ns: `/v1/user/${userId}`,
                    accessToken: this.token
                },
                transports: ['websocket', 'polling'],
                pfx: []
            });

            // for debugging, we only want one of these listeners
            if (this.debug) {
                this.socket.on('connect', () => {
                    this.log.debug('SSAPI socket connected');
                });

                this.socket.on('reconnect_attempt', (attemptNumber) => {
                    this.log.debug(`SSAPI socket reconnect_attempt #${attemptNumber}`);
                });

                this.socket.on('reconnect', () => {
                    this.log.debug('SSAPI socket reconnected');
                });

                this.socket.on('connect_error', (err) => {
                    this.log.error(`SSAPI socket connect_error${err.type && err.message ? ' ' + err.type + ': ' + err.message : ': ' + err}`);
                });

                this.socket.on('connect_timeout', () => {
                    this.log.debug('SSAPI socket connect_timeout');
                });

                this.socket.on('error', (err) => {
                    if (err.message == 'Not authorized') { //edge case
                      this.isBlocked = true;
                    }
                    this.log.error(`SSAPI socket error${err.type && err.message ? ' ' + err.type + ': ' + err.message : ': ' + err}`);
                });

                this.socket.on('reconnect_failed', () => {
                    this.log.error('SSAPI socket reconnect_failed');
                });

                this.socket.on('disconnect', (reason) => {
                    this.log.debug('SSAPI socket disconnect reason:', reason);
                });
            }
        }

        this.socket.on('connect', () => {
            callback(EVENT_TYPES.CONNECTED);
        });

        this.socket.on('error', (err) => {
            if (err) {
                this.unsubscribeFromEvents();
                callback(EVENT_TYPES.CONNECTION_LOST);
            }
        });

        this.socket.on('reconnect_failed', () => {
            this.unsubscribeFromEvents();
            callback(EVENT_TYPES.CONNECTION_LOST);
        });

        this.socket.on('disconnect', (reason) => {
            if (reason === 'io server disconnect') {
                // the disconnection was initiated by the server, you need to reconnect manually
                this.unsubscribeFromEvents();
                callback(EVENT_TYPES.CONNECTION_LOST);
            } else {
                callback(EVENT_TYPES.DISCONNECT);
            }
        });

        this.socket.on('event', _socketCallback);

    }

    isSocketConnected() {
        return this.socket && this.socket.connected;
    }

    unsubscribeFromEvents() {
        if (this.socket) {
            this.socket.off();
            this.socket.close();
            this.socket = null;
        }
    }

    subscribeToSensor(id, callback) {
        if (!this.sensorRefreshInterval) {

            this.sensorRefreshInterval = setInterval(async () => {
                if (this.sensorSubscriptions.length == 0) {
                    return;
                }

                if (this.sensorRefreshLockoutTimeout) {
                    if (this.debug) this.log.debug('Sensor refresh lockout in effect, refresh blocked.');
                    return;
                }

                try {
                    let sensors = await this.getSensors(true);
                    for (let sensor of sensors) {
                        this.sensorSubscriptions
                            .filter(sub => sub.id === sensor.serial)
                            .map(sub => sub.callback(sensor));
                    }
                } catch (err) {
                    if (!(err instanceof RateLimitError)) { // never log rate limit errors as they are handled elsewhere
                      if (this.debug) {
                          this.log.error(`Sensor refresh received an error from the SimpliSafe API:`, err);
                      } else if (!this.errorSupperessionTimeout) {
                          this.nSuppressedErrors = 1;
                          this.errorSupperessionTimeout = setTimeout(() => {
                              if (!this.debug && this.nSuppressedErrors > 0) this.log.warn(`${this.nSuppressedErrors} error${this.nSuppressedErrors > 1 ? 's were' : ' was'} received from the SimpliSafe API while refereshing sensors in the last ${errorSuppressionDuration / 60000} minutes. Enable debug logging for detailed output.`);
                              clearTimeout(this.errorSupperessionTimeout);
                              this.errorSupperessionTimeout = undefined;
                        }, errorSuppressionDuration);
                      } else {
                          this.nSuppressedErrors++;
                      }
                    }
                }

            }, this.sensorRefreshTime);

        }

        this.sensorSubscriptions.push({
            id: id,
            callback: callback
        });
    }

    unsubscribeFromSensor(id) {
        this.sensorSubscriptions = this.sensorSubscriptions.filter(sub => sub.id !== id);
        if (this.sensorSubscriptions.length == 0) {
            clearInterval(this.sensorRefreshInterval);
        }
    }

    handleSensorRefreshLockout() {
        if (!this.sensorRefreshLockoutEnabled) return;
        // avoid "smart lock not responding" error with refresh lockout, see issue #134
        clearTimeout(this.sensorRefreshLockoutTimeout);
        this.sensorRefreshLockoutTimeout = setTimeout(() => {
            this.sensorRefreshLockoutTimeout = undefined;
        }, sensorRefreshLockoutDuration);
    }

}

export default SimpliSafe3;
