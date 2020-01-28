// © 2020 Niccolò Zapponi
// SimpliSafe 3 API Wrapper

import axios from 'axios';
import io from 'socket.io-client';
import fs from 'fs';

// Do not touch these - they allow the client to make requests to the SimpliSafe API
const clientUuid = '4df55627-46b2-4e2c-866b-1521b395ded2';
const clientUsername = `${clientUuid}.WebApp.simplisafe.com`;
const clientPassword = '';
const subscriptionCacheTime = 3000; // ms
const sensorCacheTime = 3000; // ms
const internalConfigFile = '~/.homebridge/.simplisafe3.conf';
const mfaTimeout = 5 * 60 * 1000; // ms
const rateLimitInitialInterval = 60000; // ms
const rateLimitMaxInterval = 2 * 60 * 60 * 1000; // ms

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
    'DOORLOCK_2': 253
};

const generateSimplisafeId = () => {
    const supportedCharacters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789';
    let id = '';
    while (id.length < 10) {
        id.push(supportedCharacters(Math.floor(Math.random() * supportedCharacters.length)));
    }

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
    lastSubscriptionRequest;
    lastSensorRequest;
    lastLockRequest;
    sensorRefreshInterval;
    sensorRefreshTime;
    sensorSubscriptions = [];
    ssId;

    isBlocked;
    nextBlockInterval = rateLimitInitialInterval;
    nextAttempt;

    constructor(sensorRefreshTime = 15000, resetConfig = false) {
        this.sensorRefreshTime = sensorRefreshTime;

        if (fs.existsSync(internalConfigFile) && resetConfig) {
            fs.unlinkSync(internalConfigFile);
        }

        // Load IDs from internal config file
        if (fs.existsSync(internalConfigFile)) {
            let configFile = fs.readFileSync(internalConfigFile);
            let config = JSON.parse(configFile);
            console.log(`Config file found. SS-ID: ${config.ssId}`);
            this.ssId = config.ssId;
        } else {
            this.ssId = generateSimplisafeId();

            console.log(`Config file not found. Generating SS-ID: ${this.ssId}`);

            // Ensure folder path exists
            let pathComponents = internalConfigFile.split('/');
            let folderPath = pathComponents.slice(0, pathComponents.length - 1).join('/');
            fs.mkdirSync(folderPath, { recursive: true });

            fs.writeFileSync(internalConfigFile, JSON.stringify({
                ssId: this.ssId
            }));
        }
    }

    async login(username, password, storeCredentials = false) {

        if (storeCredentials) {
            this.username = username;
            this.password = password;
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

                    console.log('Multifactor authentication required. Check your email and approve the request!');

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
                        console.log('Multifactor authentication failed');
                        this.logout(storeCredentials);
                        throw err.response ? err.response : err;
                    }

                } else if (errCode == 403) {
                    console.log('Login failed, request blocked (rate limit?).');
                    this._setRateLimitHandler();
                } else {
                    this.logout(storeCredentials);
                    throw err.response;
                }
            } else {
                this.logout(storeCredentials);
                throw err;
            }
        }
    }

    async checkMultifactorAuthentication(mfaToken, oob, interval) {
        const timeLimit = Date.now() + mfaTimeout;

        const intervalChecker = new Promise((resolve, reject) => {
            setInterval(async () => {

                if (Date.now() > timeLimit) {
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
        return this.refreshToken !== null || (this.token !== null && Date.now() < this.expiry);
    }

    async refreshToken() {
        if (!this.isLoggedIn() || !this.refreshToken) {
            return Promise.reject('User is not logged in');
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
                    console.log('Token refresh failed, request blocked (rate limit?).');
                    this._setRateLimitHandler();
                } else {
                    this.logout(this.username != null);
                }
                throw err.response;
            } else {
                this.logout(this.username != null);
                throw err;
            }
        }
    }

    async request(params, tokenRefreshed = false) {

        if (this.isBlocked && Date.now() < this.nextAttempt) {
            let err = new Error('Blocking request: rate limited');
            throw err;
        }

        if (!this.isLoggedIn) {
            if (this.isBlocked) {
                // User is not logged in due to the last login attempt being blocked.
                // It's now time to try logging in again.
                await this.login(this.username, this.password, true);
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
                console.log('Request failed, request blocked (rate limit?).');
                this._setRateLimitHandler();
                throw err.response.data;
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

    async getSubscription(subId = null) {
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

        let data = await this.request({
            method: 'GET',
            url: `/subscriptions/${subscriptionId}/`
        });

        return data.subscription;
    }

    setDefaultSubscription(accountNumber) {
        if (!accountNumber) {
            throw new Error('Account Number not defined');
        }

        this.accountNumber = accountNumber;
    }

    async getAlarmState(forceRefresh = false, retry = false) {
        if (forceRefresh || !this.lastSubscriptionRequest) {
            this.lastSubscriptionRequest = this.getSubscription()
                .then(sub => {
                    return sub;
                })
                .catch(err => {
                    throw err;
                })
                .finally(() => {
                    setTimeout(() => {
                        this.lastSubscriptionRequest = null;
                    }, subscriptionCacheTime);
                });
        }
        let subscription = await this.lastSubscriptionRequest;

        if (subscription.location && subscription.location.system) {
            if (subscription.location.system.isAlarming) {
                return 'ALARM';
            }

            const validStates = ['OFF', 'HOME', 'AWAY', 'AWAY_COUNT', 'HOME_COUNT', 'ALARM_COUNT', 'ALARM'];
            let alarmState = subscription.location.system.alarmState;
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

        let data = await this.request({
            method: 'POST',
            url: `/ss3/subscriptions/${this.subId}/state/${state}`
        });
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
            this.lastSensorRequest = this.request({
                method: 'GET',
                url: `/ss3/subscriptions/${this.subId}/sensors?forceUpdate=${forceUpdate ? 'true' : 'false'}`
            })
                .then(data => {
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
        return data.sensors;
    }

    async getCameras(forceRefresh = false) {
        if (forceRefresh || !this.lastSubscriptionRequest) {
            this.lastSubscriptionRequest = this.getSubscription()
                .then(sub => {
                    return sub;
                })
                .catch(err => {
                    throw err;
                })
                .finally(() => {
                    setTimeout(() => {
                        this.lastSubscriptionRequest = null;
                    }, subscriptionCacheTime);
                });
        }
        let subscription = await this.lastSubscriptionRequest;

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
                    callback('ALARM', data);
                    break;
                case 'alarmCancel':
                    callback('OFF', data);
                    break;
                case 'activity':
                case 'activityQuiet':
                default:
                    // if it's not an alarm event, check by eventCid
                    switch (data.eventCid) {
                        case 1400:
                        case 1407:
                            // 1400 is disarmed with Master PIN, 1407 is disarmed with Remote
                            callback('DISARM', data);
                            break;
                        case 1406:
                            callback('CANCEL', data);
                            break;
                        case 1409:
                            callback('MOTION', data);
                            break;
                        case 9441:
                            callback('HOME_EXIT_DELAY', data);
                            break;
                        case 3441:
                        case 3491:
                            callback('HOME_ARM', data);
                            break;
                        case 9401:
                        case 9407:
                            // 9401 is for Keypad, 9407 is for Remote
                            callback('AWAY_EXIT_DELAY', data);
                            break;
                        case 3401:
                        case 3407:
                        case 3487:
                        case 3481:
                            // 3401 is for Keypad, 3407 is for Remote
                            callback('AWAY_ARM', data);
                            break;
                        case 1429:
                            callback('ENTRY', data);
                            break;
                        case 1110:
                        case 1154:
                        case 1159:
                        case 1162:
                        case 1132:
                        case 1134:
                        case 1120:
                            callback('ALARM', data);
                            break;
                        case 1170:
                            callback('CAMERA_MOTION', data);
                            break;
                        case 1458:
                            callback('DOORBELL', data);
                            break;
                        case 9700:
                            callback('DOORLOCK_UNLOCKED', data);
                            break;
                        case 9701:
                            callback('DOORLOCK_LOCKED', data);
                            break;
                        case 1602:
                            // Automatic test
                            break;
                        default:
                            callback(null, data);
                            break;
                    }
                    break;
            }
        };

        if (!this.socket) {
            let userId = await this.getUserId();

            this.socket = io(`https://api.simplisafe.com/v1/user/${userId}`, {
                path: '/socket.io',
                query: {
                    ns: `/v1/user/${userId}`,
                    accessToken: this.token
                },
                transports: ['websocket', 'polling']
            });

            this.socket.on('connect', () => {
                // console.log('Connect');
            });

            this.socket.on('connect_error', () => {
                // console.log('Connect_error', err);
                this.socket = null;
            });

            this.socket.on('connect_timeout', () => {
                // console.log('Connect_timeout');
                this.socket = null;
            });

            this.socket.on('error', () => {
                this.socket = null;
            });

            this.socket.on('disconnect', () => {
                this.socket = null;
            });

            this.socket.on('reconnect_failed', () => {
                // console.log('Reconnect_failed');
                this.socket = null;
            });
        }

        this.socket.on('error', err => {
            if (err === 'Not authorized') {
                callback('DISCONNECT');
            }
        });

        this.socket.on('disconnect', reason => {
            if (reason === 'transport close') {
                callback('DISCONNECT');
            }
        });

        this.socket.on('event', _socketCallback);

    }

    isSocketConnected() {
        return this.socket && this.socket.connected;
    }

    unsubscribeFromEvents() {
        if (this.socket) {
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

                try {
                    let sensors = await this.getSensors(true);
                    for (let sensor of sensors) {
                        this.sensorSubscriptions
                            .filter(sub => sub.id === sensor.serial)
                            .map(sub => sub.callback(sensor));
                    }
                } catch (err) {
                    // console.log(err);
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

}

export default SimpliSafe3;
