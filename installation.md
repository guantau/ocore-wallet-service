The following document is a step-by-step guide to run OWS.

### Prerequisites
Ensure MongoDB (2.6+) is installed and running. This document assumes that mongod is running at the default port 27017.
See the configuration section to configure a different host/port.

### Install OWS from NPM
Use the following steps to Install OWS from NPM.
```bash
npm install https://github.com/guantau/ocore-wallet-service
cd ocore-wallet-service
```
To change configuration before running, see the Configuration section.
```bash
npm start
```

### Install OWS from github source
Use the following steps to Install OWS from github source and run it with defaults.
```bash
git clone https://github.com/guantau/ocore-wallet-service.git
cd ocore-wallet-service
npm install
```
To change configuration before running, see the Configuration section.
```bash
npm start
```

### Configuration
Configuration for all required modules of OWS can be specified in https://github.com/guantau/ocore-wallet-service/blob/master/config.js. 

OWS is composed of 6 separate node services:
+ Message Broker - messagebroker/messagebroker.js
+ OByte Monitor - bcmonitor/bcmonitor.js (This service talks to OByte.)
+ Email Service - emailservice/emailservice.js
+ Fiat Rate Service - fiatrateservice/fiatservice.js
+ Push Notifications Service - pushnotificationsservice/pushnotificationsservice.js
+ OByte Wallet Service - ows.js

#### Configure MongoDB
Example configuration for connecting to the MongoDB instance:
```javascript
  storageOpts: {
    mongoDb: {
      uri: 'mongodb://localhost:27017/ows',
    },
  }
```

#### Configure Message Broker service
Example configuration for connecting to message broker service:
```javascript
  messageBrokerOpts: {
    messageBrokerServer: {
      url: 'http://localhost:3380',
    },
  }
```

#### Configure Email service
Example configuration for connecting to email service (using postfix):
```javascript
  emailOpts: {
    host: 'localhost',
    port: 25,
    secure: false,
    subjectPrefix: '[Wallet Service]',
    from: 'wallet-service@ocore.io',
  }
```

#### Enable clustering
Change `config.js` file to enable and configure clustering:
```javascript
{
  cluster: true,
  clusterInstances: 4,
}
```

