var config = {
  basePath: '/ows/api',
  disableLogs: false,
  port: 3232,

  // Uncomment to make OWS a forking server
  // cluster: true,

  // Uncomment to set the number or process (will use the nr of availalbe CPUs by default)
  // clusterInstances: 4,

  // https: true,
  // privateKeyFile: 'private.pem',
  // certificateFile: 'cert.pem',
  ////// The following is only for certs which are not
  ////// trusted by nodejs 'https' by default
  ////// CAs like Verisign do not require this
  // CAinter1: '', // ex. 'COMODORSADomainValidationSecureServerCA.crt'
  // CAinter2: '', // ex. 'COMODORSAAddTrustCA.crt'
  // CAroot: '', // ex. 'AddTrustExternalCARoot.crt'


  storageOpts: {
    mongoDb: {
      uri: 'mongodb://localhost:27017/ows',
    },
  },
  messageBrokerOpts: {
    messageBrokerServer: {
      url: 'http://localhost:3380',
    },
  },
  blockchainExplorerOpts: {
    hubUrl: 'ws://localhost:3030',
  },
  pushNotificationsOpts: {
    templatePath: './lib/templates',
    defaultLanguage: 'en',
    defaultUnit: 'one',
    subjectPrefix: '',
    pushServerUrl: 'https://fcm.googleapis.com/fcm',
    authorizationKey: 'You_have_to_put_something_here',
  },
  fiatRateServiceOpts: {
    defaultProvider: 'Bittrex',
    fetchInterval: 60, // in minutes
  },
  // To use email notifications uncomment this:
  // emailOpts: {
  //  host: 'localhost',
  //  port: 25,
  //  secure: false,
  //  auth: {
  //   user: process.env.SMTP_USER,
  //   pass: process.env.SMTP_PASS
  //  },
  //  subjectPrefix: '[Wallet Service]',
  //  from: 'wallet-service@ocore.io',
  //  templatePath: './lib/templates',
  //  defaultLanguage: 'en',
  //  defaultUnit: 'one',
  // },
};
module.exports = config;
