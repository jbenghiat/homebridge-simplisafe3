class SS3EntrySensor {

    constructor(name, id, log, debug, simplisafe, Service, Characteristic, UUIDGen) {

        this.Characteristic = Characteristic;
        this.Service = Service;
        this.id = id;
        this.log = log;
        this.debug = debug;
        this.name = name;
        this.simplisafe = simplisafe;
        this.uuid = UUIDGen.generate(id);
        this.reachable = true;

        this.startListening();
		this.version = simplisafe.version;
    }

    identify(callback) {
        if (this.debug) this.log.debug(`Identify request for ${this.name}`);
        callback();
    }

    setAccessory(accessory) {
        this.accessory = accessory;
        this.accessory.on('identify', (paired, callback) => this.identify(callback));

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Manufacturer, 'SimpliSafe')
            .setCharacteristic(this.Characteristic.Model, 'Entry Sensor')
            .setCharacteristic(this.Characteristic.SerialNumber, this.id);

        this.service = this.accessory.getService(this.Service.ContactSensor);
        this.service.getCharacteristic(this.Characteristic.ContactSensorState)
            .on('get', async callback => this.getState(callback));

        this.service.getCharacteristic(this.Characteristic.StatusLowBattery)
            .on('get', async callback => this.getBatteryStatus(callback));

        this.refreshState();
    }

    async updateReachability() {
        try {
            let sensors = await this.simplisafe.getSensors();
            let sensor = sensors.find(sen => sen.serial === this.id);
            if (!sensor) {
                this.reachable = false;
            } else {
			if (this.version == 2 ? sensor.sensorStatus : sensor.flags) {
			  this.reachable = this.version == 2 ? sensor.sensorStatus > 0 : !sensor.flags.offline;
                } else {
                    this.reachable = false;
                }
            }

            return this.reachable;
        } catch (err) {
            this.log.error(`An error occurred while updating reachability for ${this.name}`);
            this.log.error(err);
        }
    }

    async getSensorInformation() {
        try {
            let sensors = await this.simplisafe.getSensors(true);
            let sensor = sensors.find(sen => sen.serial === this.id);

            if (!sensor) {
                throw new Error('Could not find sensor');
            }

            return sensor;
        } catch (err) {
            throw new Error(`An error occurred while getting sensor: ${err}`);
        }
    }

    async getState(callback, forceRefresh = false) {
        if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) {
            return callback(new Error('Request blocked (rate limited)'));
        }

        if (!forceRefresh) {
            let characteristic = this.service.getCharacteristic(this.Characteristic.ContactSensorState);
            return callback(null, characteristic.value);
        }

        try {
            let sensor = await this.getSensorInformation();

		   if (this.version == 2 ? !sensor.entryStatus : !sensor.status) {
                throw new Error('Sensor response not understood');
            }

		    let open = this.version == 2 ? sensor.entryStatus == "open" : sensor.status.triggered;
            let homekitState = open ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
            callback(null, homekitState);

        } catch (err) {
            callback(new Error(`An error occurred while getting sensor state: ${err}`));
        }
    }

    async getBatteryStatus(callback) {
        // No need to ping API for this and HomeKit is not very patient when waiting for it
        let characteristic = this.service.getCharacteristic(this.Characteristic.StatusLowBattery);
        return callback(null, characteristic.value);
    }

    startListening() {
        this.simplisafe.subscribeToSensor(this.id, sensor => {
            if (this.service) {
			if (sensor.status || sensor.entryStatus) {
			  if (this.version == 2 ? sensor.entryStatus == "open" : sensor.status.triggered) {
                        this.service.updateCharacteristic(this.Characteristic.ContactSensorState, this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
                    } else {
                        this.service.updateCharacteristic(this.Characteristic.ContactSensorState, this.Characteristic.ContactSensorState.CONTACT_DETECTED);
                    }
                }

				if (sensor.flags || sensor.error) {
				    if (sensor.flags.lowBattery || sensor.error) {
                        this.service.updateCharacteristic(this.Characteristic.StatusLowBattery, this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
                    } else {
                        this.service.updateCharacteristic(this.Characteristic.StatusLowBattery, this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
                    }
                }
            }
        });
    }

    async refreshState() {
        if (this.debug) this.log.debug('Refreshing sensor state');
        try {
            let sensor = await this.getSensorInformation();
		    if (this.version == 2 ? !sensor.sensorStatus && !sensor.sensorData : (!sensor.status || !sensor.flags) ) {
				if (this.debug) this.log.debug(`${sensor}`);
				throw new Error(`Sensor ${this.name} response not understood`);
		    }
		    let open = this.version == 2 ? sensor.entryStatus != "closed" : sensor.status.triggered;
            let homekitSensorState = open ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
		    let batteryLow = this.version == 2 ? sensor.error : sensor.flags.lowBattery;
            let homekitBatteryState = batteryLow ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

            this.service.updateCharacteristic(this.Characteristic.ContactSensorState, homekitSensorState);
            this.service.updateCharacteristic(this.Characteristic.StatusLowBattery, homekitBatteryState);

            if (this.debug) this.log.debug(`Updated current state for ${this.name}: ${open}, ${batteryLow}`);

        } catch (err) {
            this.log.error('An error occurred while refreshing state');
            this.log.error(err);
        }
    }

}

export default SS3EntrySensor;
