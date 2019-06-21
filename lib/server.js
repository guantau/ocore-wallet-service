'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var async = require('async');
var log = require('npmlog');

log.debug = log.verbose;
log.disableColor();

var EmailValidator = require('email-validator');
var Stringify = require('json-stable-stringify');

var Bitcore = require('bitcore-lib');

var Common = require('./common');
var Utils = Common.Utils;
var Constants = Common.Constants;
var Defaults = Common.Defaults;

var ClientError = require('./errors/clienterror');
var Errors = require('./errors/errordefinitions');

var Lock = require('./lock');
var Storage = require('./storage');
var MessageBroker = require('./messagebroker');
var BlockchainExplorer = require('./blockchainexplorer');
var FiatRateService = require('./fiatrateservice');

var request = require('request');
var ValidationUtils = require('ocore/validation_utils');
var OcoreConstants = require('ocore/constants.js');
var OcoreStorage = require('ocore/storage');
var OcoreDb = require('ocore/db');
var ObjectHash = require('ocore/object_hash');
var ObjectLength = require('ocore/object_length');
var Composer = require('./transaction/composer');
var DivisibleAsset = require('./transaction/divisibleasset');
var IndivisibleAsset = require('./transaction/indivisibleasset');

var Model = require('./model');
var Wallet = Model.Wallet;

var initialized = false;

var lock;
var storage;
var blockchainExplorer;
var messageBroker;
var fiatRateService;
var serviceVersion;

/**
 * Creates an instance of the Ocore Wallet Service.
 * @constructor
 */
function WalletService() {
  if (!initialized) {
    throw new Error('Server not initialized');
  }

  this.lock = lock;
  this.storage = storage;
  this.blockchainExplorer = blockchainExplorer;
  this.messageBroker = messageBroker;
  this.fiatRateService = fiatRateService;
  this.notifyTicker = 0;
}

/**
 * Gets the current version of OWS.
 */
WalletService.getServiceVersion = function () {
  if (!serviceVersion) {
    serviceVersion = 'ows-' + require('../package').version;
  }

  return serviceVersion;
};

/**
 * Initializes global settings for all instances.
 * @param {Object} opts
 * @param {Object} opts.request [Optional] - The network request library.
 * @param {Storage} opts.storage [Optional] - The storage provider.
 * @param {BlockchainExplorer} opts.blockchainExplorer [Optional] - The blockchain storage provider.
 * @param {MessageBroker} opts.messageBroker [Optional] - The message broker provider.
 * @param {FiatRateService} opts.fiatRateService [Optional] - The fiat rate service provider.
 * @param {Lock} opts.lock [Optional] - The lock service provider.
 * @param {Callback} cb
 */
WalletService.initialize = function (opts, cb) {
  $.shouldBeFunction(cb);

  opts = opts || {};

  if (opts.request) {
    request = opts.request;
  }

  function initStorage(cb) {
    if (opts.storage) {
      storage = opts.storage;
      return cb();
    } else {
      var newStorage = new Storage();
      newStorage.connect(opts.storageOpts, function (err) {
        if (err) {
          return cb(err);
        }
        storage = newStorage;
        return cb();
      });
    }
  }

  function initBlockchainExplorer(cb) {
    blockchainExplorer = opts.blockchainExplorer || new BlockchainExplorer(opts.blockchainExplorerOpts);
    return cb();
  }

  function initMessageBroker(cb) {
    messageBroker = opts.messageBroker || new MessageBroker(opts.messageBrokerOpts);
    if (messageBroker) {
      messageBroker.onMessage(WalletService.handleIncomingNotifications);
    }
    return cb();
  }

  function initFiatRateService(cb) {
    if (opts.fiatRateService) {
      fiatRateService = opts.fiatRateService;
      return cb();
    } else {
      var newFiatRateService = new FiatRateService();
      var opts2 = opts.fiatRateServiceOpts || {};
      opts2.storage = storage;
      newFiatRateService.init(opts2, function (err) {
        if (err) {
          return cb(err);
        }
        fiatRateService = newFiatRateService;
        return cb();
      });
    }
  }

  async.series([
    function (next) {
      initStorage(next);
    },
    function (next) {
      initBlockchainExplorer(next);
    },
    function (next) {
      initMessageBroker(next);
    },
    function (next) {
      initFiatRateService(next);
    },
  ], function (err) {
    lock = opts.lock || new Lock(storage, opts.lockOpts);

    if (err) {
      log.error('Could not initialize', err);
      throw err;
    }
    initialized = true;
    return cb();
  });
};

/**
 * Handle notifications from message broker.
 */
WalletService.handleIncomingNotifications = function (notification, cb) {
  cb = cb || function () { };

  // do nothing here....
  return cb();
};

/**
 * Shutdown the instance of the Ocore Wallet Service.
 * @param {Callback} cb 
 */
WalletService.shutDown = function (cb) {
  if (!initialized) {
    return cb();
  }

  storage.disconnect(function (err) {
    if (err) {
      return cb(err);
    }

    initialized = false;
    return cb();
  });
};

/**
 * Gets an instance of the server without authentication.
 * @param {Object} opts
 * @param {String} opts.clientVersion [Required] - A string that identifies the client issuing the request
 */
WalletService.getInstance = function (opts) {
  opts = opts || {};

  var version = Utils.parseVersion(opts.clientVersion);
  if (version && version.agent === 'owc') {
    if (version.major === 0 && version.minor < 1) {
      throw new ClientError(Errors.codes.UPGRADE_NEEDED, 'OWC clients < 0.1 are not supported.');
    }
  }

  var server = new WalletService();
  server._setClientVersion(opts.clientVersion);
  server._setAppVersion(opts.userAgent);
  server.userAgent = opts.userAgent;
  return server;
};

/**
 * Gets an instance of the server after authenticating the copayer.
 * @param {Object} opts
 * @param {String} opts.copayerId [Required] - The copayer id making the request.
 * @param {String} opts.message [Optional] - The contents of the request to be signed. Only needed if no session token is provided.
 * @param {String} opts.signature [Optional] - Signature of message to be verified using one of the copayer's requestPubKeys. Only needed if no session token is provided.
 * @param {String} opts.session [Optional] - A valid session token previously obtained using the #login method
 * @param {String} opts.clientVersion [Required] - A string that identifies the client issuing the request.
 * @param {String} opts.walletId [Optional] - The wallet id to use as current wallet for this request (only when copayer is support staff).
 */
WalletService.getInstanceWithAuth = function (opts, cb) {
  function withSignature(cb) {
    if (!Utils.checkRequired(opts, ['copayerId', 'message', 'signature'], cb)) {
      return;
    }

    var server;
    try {
      server = WalletService.getInstance(opts);
    } catch (ex) {
      return cb(ex);
    }

    server.storage.fetchCopayerLookup(opts.copayerId, function (err, copayer) {
      if (err) {
        return cb(err);
      }
      if (!copayer) {
        return cb(new ClientError(Errors.codes.NOT_AUTHORIZED, 'Copayer not found'));
      }

      if (!copayer.isSupportStaff) {
        var isValid = !!server._getSigningKey(opts.message, opts.signature, copayer.requestPubKeys);
        if (!isValid) {
          return cb(new ClientError(Errors.codes.NOT_AUTHORIZED, 'Invalid signature'));
        }

        server.walletId = copayer.walletId;
      } else {
        server.walletId = opts.walletId || copayer.walletId;
        server.copayerIsSupportStaff = true;
      }

      server.copayerId = opts.copayerId;
      return cb(null, server);
    });
  }

  function withSession(cb) {
    if (!Utils.checkRequired(opts, ['copayerId', 'session'], cb)) {
      return;
    }

    var server;
    try {
      server = WalletService.getInstance(opts);
    } catch (ex) {
      return cb(ex);
    }

    server.storage.getSession(opts.copayerId, function (err, s) {
      if (err) {
        return cb(err);
      }

      var isValid = s && s.id === opts.session && s.isValid();
      if (!isValid) {
        return cb(new ClientError(Errors.codes.NOT_AUTHORIZED, 'Session expired'));
      }

      server.storage.fetchCopayerLookup(opts.copayerId, function (err, copayer) {
        if (err) {
          return cb(err);
        }
        if (!copayer) {
          return cb(new ClientError(Errors.codes.NOT_AUTHORIZED, 'Copayer not found'));
        }

        server.copayerId = opts.copayerId;
        server.walletId = copayer.walletId;
        return cb(null, server);
      });
    });
  }

  var authFn = opts.session ? withSession : withSignature;
  return authFn(cb);
};

/**
 * Run task with lock of wallet id
 * @param {Callback} cb [Required]
 * @param {Function} task [Required] - Task function.
 * @param {Number} waitTime [Optional] - Wait time before unlock.
 */
WalletService.prototype._runLocked = function (cb, task, waitTime) {
  $.checkState(this.walletId);

  this.lock.runLocked(this.walletId, { waitTime: waitTime }, cb, task);
};

WalletService.prototype.logi = function () {
  if (!this) {
    return log.info.apply(this, arguments);
  }
  if (!this.walletId) {
    return log.info.apply(this, arguments);
  }

  var args = [].slice.call(arguments);
  args.unshift('<' + this.walletId + '>');
  log.info.apply(this, args);
};

WalletService.prototype.logw = function () {
  if (!this) {
    return log.info.apply(this, arguments);
  }
  if (!this.walletId) {
    return log.info.apply(this, arguments);
  }

  var args = [].slice.call(arguments);
  args.unshift('<' + this.walletId + '>');
  log.warn.apply(this, args);
};

WalletService.prototype.login = function (opts, cb) {
  var self = this;

  var session;
  async.series([

    function (next) {
      self.storage.getSession(self.copayerId, function (err, s) {
        if (err) {
          return next(err);
        }
        session = s;
        next();
      });
    },

    function (next) {
      if (!session || !session.isValid()) {
        session = Model.Session.create({
          copayerId: self.copayerId,
          walletId: self.walletId,
        });
      } else {
        session.touch();
      }
      next();
    },

    function (next) {
      self.storage.storeSession(session, next);
    },

  ], function (err) {
    if (err) {
      return cb(err);
    }
    if (!session) {
      return cb(new Error('Could not get current session for this copayer'));
    }

    return cb(null, session.id);
  });
};

WalletService.prototype.logout = function (opts, cb) {
  var self = this;

  self.storage.removeSession(self.copayerId, cb);
};

/**
 * Get all copayers with deviceId
 * @param {Object} opts
 * @param {String} opts.deviceId [Required] - The device id.
 */
WalletService.prototype.getCopayers = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['deviceId'], cb)) {
    return;
  }

  if (_.isEmpty(opts.deviceId)) {
    return cb('Invalid device id');
  }

  self.storage.fetchCopayers(opts.deviceId, function (err, copayers) {
    if (err) return cb(err);
    if (!copayers) return cb(Errors.COPAYER_NOT_FOUND);
    return cb(null, copayers);
  });
}

/**
 * Creates a new wallet.
 * @param {Object} opts
 * @param {String} opts.id [Optional] - The wallet id.
 * @param {String} opts.name [Required] - The wallet name.
 * @param {Number} opts.m [Required] - Required copayers.
 * @param {Number} opts.n [Required] - Total copayers.
 * @param {String} opts.pubKey [Required] - Public key to verify copayers joining have access to the wallet secret.
 * @param {String} opts.singleAddress [Optional] - The wallet will only ever have one address. (defaults to true).
 * @param {String} opts.coin [Optional] - The coin for this wallet. (defaults to 'obyte').
 * @param {String} opts.network [Optional] - The network for this wallet. (defaults to 'livenet').
 * @param {String} opts.supportBIP44 [Optional] - Client supports BIP44 for new wallets. (defaults to true).
 */
WalletService.prototype.createWallet = function (opts, cb) {
  var self = this,
    pubKey;

  if (!Utils.checkRequired(opts, ['name', 'm', 'n', 'pubKey'], cb)) {
    return;
  }

  if (_.isEmpty(opts.name)) {
    return cb(new ClientError('Invalid wallet name'));
  }

  if (!Wallet.verifyCopayerLimits(opts.m, opts.n)) {
    return cb(new ClientError('Invalid combination of required copayers / total copayers'));
  }

  opts.coin = opts.coin || Defaults.COIN;
  if (!Utils.checkValueInCollection(opts.coin, Constants.COINS)) {
    return cb(new ClientError('Invalid coin'));
  }

  opts.network = opts.network || 'livenet';
  if (!Utils.checkValueInCollection(opts.network, Constants.NETWORKS)) {
    return cb(new ClientError('Invalid network'));
  }

  opts.supportBIP44 = _.isBoolean(opts.supportBIP44) ? opts.supportBIP44 : true;

  var derivationStrategy = opts.supportBIP44 ?
    Constants.DERIVATION_STRATEGIES.BIP44 : Constants.DERIVATION_STRATEGIES.BIP45;
  var addressType = (opts.n === 1 && opts.supportBIP44) ?
    Constants.ADDRESS_TYPES.NORMAL : Constants.ADDRESS_TYPES.SHARED;

  try {
    pubKey = new Bitcore.PublicKey.fromString(opts.pubKey);
  } catch (ex) {
    return cb(new ClientError('Invalid public key'));
  }

  opts.singleAddress = _.isBoolean(opts.singleAddress) ? opts.singleAddress : true;

  var newWallet;
  async.series([

    function (acb) {
      if (!opts.id) {
        return acb();
      }

      self.storage.fetchWallet(opts.id, function (err, wallet) {
        if (wallet) {
          return acb(Errors.WALLET_ALREADY_EXISTS);
        }
        return acb(err);
      });
    },

    function (acb) {
      var wallet = Wallet.create({
        id: opts.id,
        name: opts.name,
        m: opts.m,
        n: opts.n,
        coin: opts.coin,
        network: opts.network,
        pubKey: pubKey.toString(),
        singleAddress: !!opts.singleAddress,
        derivationStrategy: derivationStrategy,
        addressType: addressType,
      });
      self.storage.storeWallet(wallet, function (err) {
        self.logi('Wallet created', wallet.id, opts.network);
        newWallet = wallet;
        return acb(err);
      });
    }

  ], function (err) {
    return cb(err, newWallet ? newWallet.id : null);
  });
};

/**
 * Retrieves a wallet from storage.
 * @param {Object} opts
 * @returns {Object} wallet
 */
WalletService.prototype.getWallet = function (opts, cb) {
  var self = this;

  self.storage.fetchWallet(self.walletId, function (err, wallet) {
    if (err) return cb(err);
    if (!wallet) return cb(Errors.WALLET_NOT_FOUND);

    return cb(null, wallet);
  });
};

/**
 * Retrieves a wallet from storage.
 * @param {Object} opts
 * @param {String} opts.identifier [Required] - The identifier associated with the wallet (one of: walletId, address, txid).
 * @returns {Object} wallet
 */
WalletService.prototype.getWalletFromIdentifier = function (opts, cb) {
  var self = this;

  if (!opts.identifier) return cb();

  var walletId;
  async.parallel([

    function (done) {
      self.storage.fetchWallet(opts.identifier, function (err, wallet) {
        if (wallet) walletId = wallet.id;
        return done(err);
      });
    },

    function (done) {
      self.storage.fetchAddressByCoin(Defaults.COIN, opts.identifier, function (err, address) {
        if (address) walletId = address.walletId;
        return done(err);
      });
    },

    function (done) {
      self.storage.fetchTxByHash(opts.identifier, function (err, tx) {
        if (tx) walletId = tx.walletId;
        return done(err);
      });
    },

  ], function (err) {
    if (err) return cb(err);
    if (walletId) {
      return self.storage.fetchWallet(walletId, cb);
    }

    return cb();
  });
};

/**
 * Retrieves wallet status.
 * @param {Object} opts
 * @param {Object} opts.includeExtendedInfo [Optional] - Include PKR info & address managers for wallet & copayers
 * @returns {Object} status
 */
WalletService.prototype.getStatus = function (opts, cb) {
  var self = this;

  opts = opts || {};

  var status = {};
  async.parallel([

    function (next) {
      self.getWallet({}, function (err, wallet) {
        if (err) return next(err);

        var walletExtendedKeys = ['publicKeyRing', 'pubKey', 'addressManager'];
        var copayerExtendedKeys = ['xPubKey', 'requestPubKey', 'signature', 'addressManager', 'customData'];

        wallet.copayers = _.map(wallet.copayers, function (copayer) {
          if (copayer.id == self.copayerId) return copayer;
          return _.omit(copayer, 'customData');
        });
        if (!opts.includeExtendedInfo) {
          wallet = _.omit(wallet, walletExtendedKeys);
          wallet.copayers = _.map(wallet.copayers, function (copayer) {
            return _.omit(copayer, copayerExtendedKeys);
          });
        }
        status.wallet = wallet;

        next();
      });
    },

    function (next) {
      opts.wallet = status.wallet;
      self.getBalance(opts, function (err, balance) {
        // ignore WALLET_NEED_SCAN err if includeExtendedInfo is given (to allow `importWallet` to import a wallet, while scan has failed)
        if (opts.includeExtendedInfo) {
          if (err && err.code != 'WALLET_NEED_SCAN') {
            return next(err);
          }
        } else if (err) {
          return next(err);
        }

        status.balance = balance;
        next();
      });
    },

    function (next) {
      self.getPendingTxs({}, function (err, pendingTxps) {
        if (err) return next(err);
        status.pendingTxps = pendingTxps;
        next();
      });
    },

    function (next) {
      self.getPreferences({}, function (err, preferences) {
        if (err) return next(err);
        status.preferences = preferences;
        next();
      });
    },

  ], function (err) {
    if (err) return cb(err);
    return cb(null, status);
  });
};

/**
 * Verifies a signature
 * @param {String} text
 * @param {String} signature
 * @param {String} pubkey
 */
WalletService.prototype._verifySignature = function (text, signature, pubkey) {
  return Utils.verifyMessage(text, signature, pubkey);
};

/**
 * Verifies a request public key
 * @param {String} requestPubKey
 * @param {String} signature
 * @param {String} xPubKey
 */
WalletService.prototype._verifyRequestPubKey = function (requestPubKey, signature, xPubKey) {
  var pub = (new Bitcore.HDPublicKey(xPubKey)).deriveChild(Constants.PATHS.REQUEST_KEY_AUTH).publicKey;
  return Utils.verifyMessage(requestPubKey, signature, pub.toString());
};

/**
 * Verifies signature against a collection of pubkeys
 * @param {String} text
 * @param {String} signature
 * @param {Array} pubKeys
 */
WalletService.prototype._getSigningKey = function (text, signature, pubKeys) {
  var self = this;
  return _.find(pubKeys, function (item) {
    return self._verifySignature(text, signature, item.key);
  });
};

/**
 * _notify
 *
 * @param {String} type
 * @param {Object} data
 * @param {Object} opts
 * @param {Boolean} opts.isGlobal [Optional] - If true, the notification is not issued on behalf of any particular copayer (defaults to false)
 */
WalletService.prototype._notify = function (type, data, opts, cb) {
  var self = this;

  if (_.isFunction(opts)) {
    cb = opts;
    opts = {};
  }
  opts = opts || {};

  //self.logi('Notification', type);

  cb = cb || function () { };

  var walletId = self.walletId || data.walletId;
  var copayerId = self.copayerId || data.copayerId;

  $.checkState(walletId);

  var notification = Model.Notification.create({
    type: type,
    data: data,
    ticker: self.notifyTicker++,
    creatorId: opts.isGlobal ? null : copayerId,
    walletId: walletId,
  });

  self.storage.storeNotification(walletId, notification, function () {
    self.messageBroker.send(notification);
    return cb();
  });
};

WalletService.prototype._notifyTxProposalAction = function (type, txp, extraArgs, cb) {
  var self = this;

  if (_.isFunction(extraArgs)) {
    cb = extraArgs;
    extraArgs = {};
  }

  var data = _.assign({
    txProposalId: txp.id,
    creatorId: txp.creatorId,
    app: txp.app,
    message: txp.message,
  }, extraArgs);

  if (txp.app == 'payment') {
    data.asset = txp.params.asset;
    data.amount = txp.getTotalAmount();
    
    if (txp.params.asset == 'base' || txp.params.asset == null) {
      data.decimals = 0;
      data.ticker = 'BYTES';
      self._notify(type, data, {}, cb);
    } else {
      self.storage.fetchAssetByUnit(txp.params.asset, function (err, result) {
        if (err || _.isEmpty(result)) {
          data.decimals = 0;
          data.ticker = 'UNKNOWN';
          self._notify(type, data, {}, cb);
        } else {
          data.decimals = result[0].decimals;
          data.ticker = result[0].ticker;
          self._notify(type, data, {}, cb);
        }
      });
    }
  } else {
    self._notify(type, data, {}, cb);
  }
};

WalletService.prototype._addCopayerToWallet = function (wallet, opts, cb) {
  var self = this;

  var copayer = Model.Copayer.create({
    coin: wallet.coin,
    name: opts.name,
    deviceId: opts.deviceId,
    account: opts.account,
    xPubKey: opts.xPubKey,
    requestPubKey: opts.requestPubKey,
    signature: opts.copayerSignature,
    customData: opts.customData,
    derivationStrategy: wallet.derivationStrategy,
  });

  self.storage.fetchCopayerLookup(copayer.id, function (err, res) {
    if (err) return cb(err);
    if (res) return cb(Errors.COPAYER_REGISTERED);

    if (opts.dryRun) return cb(null, {
      copayerId: null,
      wallet: wallet
    });

    wallet.addCopayer(copayer);
    self.storage.storeWalletAndUpdateCopayersLookup(wallet, function (err) {
      if (err) return cb(err);
      async.series([

        function (next) {
          self._notify('NewCopayer', {
            walletId: opts.walletId,
            copayerId: copayer.id,
            copayerName: copayer.name,
          }, next);
        },

        function (next) {
          if (wallet.isComplete() && wallet.isShared()) {
            self._notify('WalletComplete', {
              walletId: opts.walletId,
            }, {
                isGlobal: true
              }, next);
          } else {
            next();
          }
        },

      ], function () {
        return cb(null, {
          copayerId: copayer.id,
          wallet: wallet
        });
      });
    });
  });
};

WalletService.prototype._addKeyToCopayer = function (wallet, copayer, opts, cb) {
  var self = this;
  wallet.addCopayerRequestKey(copayer.copayerId, opts.requestPubKey, opts.signature, opts.restrictions, opts.name);
  self.storage.storeWalletAndUpdateCopayersLookup(wallet, function (err) {
    if (err) return cb(err);

    return cb(null, {
      copayerId: copayer.id,
      wallet: wallet
    });
  });
};

/**
 * Adds access to a given copayer
 *
 * @param {Object} opts
 * @param {String} opts.copayerId [Required] - The copayer id
 * @param {String} opts.requestPubKey [Required] - Public Key used to check requests from this copayer.
 * @param {String} opts.copayerSignature [Required] - S(requestPubKey). Used by other copayers to verify the that the copayer is himself (signed with REQUEST_KEY_AUTH)
 * @param {String} opts.restrictions [Optional] - cannotProposeTXs, cannotXXX TODO
 * @param {String} opts.name [Optional] - (name for the new access)
 */
WalletService.prototype.addAccess = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['copayerId', 'requestPubKey', 'signature'], cb)) return;

  self.storage.fetchCopayerLookup(opts.copayerId, function (err, copayer) {
    if (err) return cb(err);
    if (!copayer) return cb(Errors.NOT_AUTHORIZED);
    self.storage.fetchWallet(copayer.walletId, function (err, wallet) {
      if (err) return cb(err);
      if (!wallet) return cb(Errors.NOT_AUTHORIZED);

      var xPubKey = _.find(wallet.copayers, {
        id: opts.copayerId
      }).xPubKey;

      if (!self._verifyRequestPubKey(opts.requestPubKey, opts.signature, xPubKey)) {
        return cb(Errors.NOT_AUTHORIZED);
      }

      if (copayer.requestPubKeys.length > Defaults.MAX_KEYS)
        return cb(Errors.TOO_MANY_KEYS);

      self._addKeyToCopayer(wallet, copayer, opts, cb);
    });
  });
};

WalletService.prototype._setClientVersion = function (version) {
  delete this.parsedClientVersion;
  this.clientVersion = version;
};

WalletService.prototype._setAppVersion = function (userAgent) {
  var parsed = Utils.parseAppVersion(userAgent);
  if (!parsed) {
    this.appName = this.appVersion = null;
  } else {
    this.appName = parsed.app;
    this.appVersion = parsed;
  }
};

WalletService.prototype._parseClientVersion = function () {
  if (_.isUndefined(this.parsedClientVersion)) {
    this.parsedClientVersion = Utils.parseVersion(this.clientVersion);
  }
  return this.parsedClientVersion;
};

WalletService._getCopayerHash = function (name, xPubKey, requestPubKey) {
  return [name, xPubKey, requestPubKey].join('|');
};

/**
 * Joins a wallet in creation.
 * @param {Object} opts
 * @param {String} opts.walletId [Required] - The wallet id.
 * @param {String} opts.deviceId [Required] - The device id.
 * @param {String} opts.coin  [Optional] - The expected coin for this wallet. (defaults to 'obyte').
 * @param {String} opts.name [Required] - The copayer name.
 * @param {String} opts.xPubKey [Required] - Extended Public Key for this copayer.
 * @param {String} opts.account [Required] - Account index for this copayer.
 * @param {String} opts.requestPubKey [Required] - Public Key used to check requests from this copayer.
 * @param {String} opts.copayerSignature [Required] - S(name|xPubKey|requestPubKey). Used by other copayers to verify that the copayer joining knows the wallet secret.
 * @param {String} opts.customData [Optional] - Custom data for this copayer.
 * @param {String} opts.dryRun [Optional] - Simulate the action but do not change server state. (defaults to false).
 * @param {String} opts.supportBIP44 [Optional] - Client supports BIP44 for joining wallets. (defaults to true).
 */
WalletService.prototype.joinWallet = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['deviceId', 'walletId', 'name', 'xPubKey', 'account', 'requestPubKey', 'copayerSignature'], cb)) return;

  if (_.isEmpty(opts.name))
    return cb(new ClientError('Invalid copayer name'));

  opts.coin = opts.coin || Defaults.COIN;
  if (!Utils.checkValueInCollection(opts.coin, Constants.COINS))
    return cb(new ClientError('Invalid coin'));

  var xPubKey;
  try {
    xPubKey = Bitcore.HDPublicKey(opts.xPubKey);
  } catch (ex) {
    return cb(new ClientError('Invalid extended public key'));
  }
  if (_.isUndefined(xPubKey.network)) {
    return cb(new ClientError('Invalid extended public key'));
  }

  opts.supportBIP44 = _.isBoolean(opts.supportBIP44) ? opts.supportBIP44 : true;

  self.walletId = opts.walletId;
  self._runLocked(cb, function (cb) {
    self.storage.fetchWallet(opts.walletId, function (err, wallet) {
      if (err) return cb(err);
      if (!wallet) return cb(Errors.WALLET_NOT_FOUND);

      if (opts.coin != wallet.coin) {
        return cb(new ClientError('The wallet you are trying to join was created for a different coin'));
      }

      if (wallet.network != xPubKey.network.name) {
        return cb(new ClientError('The wallet you are trying to join was created for a different network'));
      }

      if (opts.supportBIP44) {
        // New client trying to join legacy wallet
        if (wallet.derivationStrategy == Constants.DERIVATION_STRATEGIES.BIP45) {
          return cb(new ClientError('The wallet you are trying to join was created with an older version of the client app.'));
        }
      } else {
        // Legacy client trying to join new wallet
        if (wallet.derivationStrategy == Constants.DERIVATION_STRATEGIES.BIP44) {
          return cb(new ClientError(Errors.codes.UPGRADE_NEEDED, 'To join this wallet you need to upgrade your client app.'));
        }
      }

      var hash = WalletService._getCopayerHash(opts.name, opts.xPubKey, opts.requestPubKey);
      if (!self._verifySignature(hash, opts.copayerSignature, wallet.pubKey)) {
        return cb(new ClientError());
      }

      if (_.find(wallet.copayers, {
        xPubKey: opts.xPubKey
      })) return cb(Errors.COPAYER_IN_WALLET);

      if (wallet.copayers.length == wallet.n) return cb(Errors.WALLET_FULL);

      self._addCopayerToWallet(wallet, opts, cb);
    });
  });
};

/**
 * Update wallet name and copayer name
 * @param {Object} opts
 * @param {String} opts.walletName [Optional] - The wallet name.
 * @param {String} opts.copayerName [Optional] - The copayer name.
 */
WalletService.prototype.updateWallet = function (opts, cb) {
  var self = this;

  if (_.isEmpty(opts.walletName) && _.isEmpty(opts.copayerName))
    return cb(new ClientError('Empty wallet and copayer name'));

  if (opts.copayerName && _.isEmpty(opts.copayerSignature))
    return cb(new ClientError('Empty copayer signature'));

  self._runLocked(cb, function (cb) {
    self.storage.fetchWallet(self.walletId, function (err, wallet) {
      if (err) return cb(err);
      if (!wallet) return cb(Errors.WALLET_NOT_FOUND);

      var copayer = wallet.getCopayer(self.copayerId);
      if (!copayer) return cb(Errors.COPAYER_NOT_FOUND);

      if (opts.walletName) wallet.name = opts.walletName;
      if (opts.copayerName) {
        copayer.name = opts.copayerName;
        copayer.signature = opts.copayerSignature;
        var requestPubKey = _.find(copayer.requestPubKeys, {key: copayer.requestPubKey});
        if (!requestPubKey) return cb(new ClientError('Request public key not found'));
        requestPubKey.signature = opts.copayerSignature;
      }

      self.storage.storeWalletAndUpdateCopayersLookup(wallet, function (err) {
        if (err) return cb(err);
        return cb(null, wallet);
      });
    });
  });
};

/**
 * Save copayer preferences for the current wallet/copayer pair.
 * @param {Object} opts
 * @param {String} opts.email [Optional] - Email address for notifications.
 * @param {String} opts.language [Optional] - Language used for notifications.
 * @param {String} opts.unit [Optional] - Obyte unit used to format amounts in notifications.
 */
WalletService.prototype.savePreferences = function (opts, cb) {
  var self = this;

  opts = opts || {};

  var preferences = [{
    name: 'email',
    isValid: function (value) {
      return EmailValidator.validate(value);
    },
  }, {
    name: 'language',
    isValid: function (value) {
      return _.isString(value) && value.length == 2;
    },
  }, {
    name: 'unit',
    isValid: function (value) {
      return _.isString(value) && _.includes(['one', 'kilo', 'mega', 'giga'], value.toLowerCase());
    },
  }];

  opts = _.pick(opts, _.map(preferences, 'name'));
  try {
    _.each(preferences, function (preference) {
      var value = opts[preference.name];
      if (!value) return;
      if (!preference.isValid(value)) {
        throw 'Invalid ' + preference.name;
        return false;
      }
    });
  } catch (ex) {
    return cb(new ClientError(ex));
  }

  self._runLocked(cb, function (cb) {
    self.storage.fetchPreferences(self.walletId, self.copayerId, function (err, oldPref) {
      if (err) return cb(err);

      var newPref = Model.Preferences.create({
        walletId: self.walletId,
        copayerId: self.copayerId,
      });
      var preferences = Model.Preferences.fromObj(_.defaults(newPref, opts, oldPref));
      self.storage.storePreferences(preferences, function (err) {
        return cb(err);
      });
    });
  });
};

/**
 * Retrieves a preferences for the current wallet/copayer pair.
 * @param {Object} opts
 * @returns {Object} preferences
 */
WalletService.prototype.getPreferences = function (opts, cb) {
  var self = this;

  self.storage.fetchPreferences(self.walletId, self.copayerId, function (err, preferences) {
    if (err) return cb(err);
    return cb(null, preferences || {});
  });
};

WalletService.prototype._canCreateAddress = function (ignoreMaxGap, cb) {
  var self = this;

  if (ignoreMaxGap) return cb(null, true);

  self.storage.fetchAddresses(self.walletId, function (err, addresses) {
    if (err) return cb(err);
    var latestAddresses = _.takeRight(_.reject(addresses, {
      isChange: true
    }), Defaults.MAX_MAIN_ADDRESS_GAP);
    if (latestAddresses.length < Defaults.MAX_MAIN_ADDRESS_GAP || _.some(latestAddresses, {
      hasActivity: true
    })) return cb(null, true);

    var activityFound = false;
    var i = latestAddresses.length;
    async.whilst(function () {
      return i > 0 && !activityFound;
    }, function (next) {
      blockchainExplorer.getAddressActivity(latestAddresses[--i].address, function (err, res) {
        if (err) return next(err);
        activityFound = !!res;
        return next();
      });
    }, function (err) {
      if (err) return cb(err);
      if (!activityFound) return cb(null, false);

      var address = latestAddresses[i];
      address.hasActivity = true;
      self.storage.storeAddress(address, function (err) {
        return cb(err, true);
      });
    });
  });
};

WalletService.prototype._store = function (wallet, address, cb) {
  var self = this;
  self.storage.storeAddressAndWallet(wallet, address, (err) => {
    if (err) return cb(err);
    if (!address.isChange) self.messageBroker.addAddress(address);
    return cb();
  });
};

/**
 * Creates a new address.
 * @param {Object} opts
 * @param {Boolean} opts.ignoreMaxGap [Optional] - Ignore constraint of maximum number of consecutive addresses without activity. (defaults to false).
 * @returns {Address} address
 */
WalletService.prototype.createAddress = function (opts, cb) {
  var self = this;

  opts = opts || {};

  function createNewAddress(wallet, cb) {
    var address;
    try {
      address = wallet.createAddress(false);
    } catch (e) {
      log.warn("Error creating address for " + self.walletId, e);
      return cb("Bad xPub");
    };

    self._store(wallet, address, function (err) {
      if (err) return cb(err);

      self._notify('NewAddress', {
        address: address.address,
      }, function () {
        return cb(null, address);
      });
    }, true);
  };

  function getFirstAddress(wallet, cb) {
    self.storage.fetchAddresses(self.walletId, function (err, addresses) {
      if (err) return cb(err);
      if (!_.isEmpty(addresses)) return cb(null, _.head(addresses));
      return createNewAddress(wallet, cb);
    });
  };

  self._canCreateAddress(opts.ignoreMaxGap, function (err, canCreate) {
    if (err) return cb(err);
    if (!canCreate) return cb(Errors.MAIN_ADDRESS_GAP_REACHED);

    self._runLocked(cb, function (cb) {
      self.getWallet({}, function (err, wallet) {
        if (err) return cb(err);
        if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);
        if (wallet.scanStatus == 'error')
          return cb(Errors.WALLET_NEED_SCAN);

        var createFn = wallet.singleAddress ? getFirstAddress : createNewAddress;
        return createFn(wallet, (err, address) => {
          if (err) {
            return cb(err);
          }
          return cb(err, address);
        });
      });
    }, 10 * 1000);
  });
};

/**
 * Get all addresses.
 * @param {Object} opts
 * @param {Numeric} opts.limit [Optional] - Limit the resultset. Return all addresses by default.
 * @param {Boolean} opts.reverse [Optional] - Reverse the order of returned addresses. (defaults to false).
 * @returns {Address[]}
 */
WalletService.prototype.getMainAddresses = function (opts, cb) {
  var self = this;

  opts = opts || {};
  self.storage.fetchAddresses(self.walletId, function (err, addresses) {
    if (err) return cb(err);

    var onlyMain = _.reject(addresses, {
      isChange: true
    });
    if (opts.reverse) onlyMain.reverse();
    if (opts.limit > 0) onlyMain = _.take(onlyMain, opts.limit);

    return cb(null, onlyMain);
  });
};

/**
 * Verifies that a given message was actually sent by an authorized copayer.
 * @param {Object} opts
 * @param {String} opts.message [Required] - The message to verify.
 * @param {String} opts.signature [Required] - The signature of message to verify.
 * @returns {Boolean} The result of the verification.
 */
WalletService.prototype.verifyMessageSignature = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['message', 'signature'], cb)) return;

  self.getWallet({}, function (err, wallet) {
    if (err) return cb(err);

    var copayer = wallet.getCopayer(self.copayerId);

    var isValid = !!self._getSigningKey(opts.message, opts.signature, copayer.requestPubKeys);
    return cb(null, isValid);
  });
};

WalletService.prototype._getUtxosForCurrentWallet = function (opts, cb) {
  var self = this;
  var opts = opts || {};

  function utxoKey(utxo) {
    return utxo.unit + '|' + utxo.message_index + '|' + utxo.output_index;
  };

  var coin, allAddresses, allUtxos, utxoIndex, addressStrs, wallet;
  async.series([

    function (next) {
      self.getWallet({}, function (err, w) {
        if (err) return next(err);
        wallet = w;
        if (wallet.scanStatus == 'error')
          return cb(Errors.WALLET_NEED_SCAN);
        coin = wallet.coin;
        return next();
      });
    },

    function (next) {
      if (_.isArray(opts.addresses)) {
        allAddresses = opts.addresses;
        return next();
      }

      // even with Grouping we need address for pubkeys and path (see last step)
      self.storage.fetchAddresses(self.walletId, function (err, addresses) {
        allAddresses = addresses;
        if (allAddresses.length == 0) return cb(null, []);
        return next();
      });
    },

    function (next) {
      addressStrs = _.map(allAddresses, 'address');
      return next();
    },

    function (next) {
      if (!wallet.isComplete()) return next();

      blockchainExplorer.getUtxos(addressStrs, opts.asset, function (err, utxos) {
        if (err) return next(err);
        if (utxos.length == 0) return cb(null, []);
        allUtxos = utxos;
        utxoIndex = _.keyBy(allUtxos, utxoKey);
        return next();
      });
    },

    function (next) {
      self.getPendingTxs({}, function (err, txps) {
        if (err) return next(err);

        var lockedInputs = [];

        _.each(txps, function(txp) {
          _.each(txp.unit.messages, function (message) {
            if (message.app == "payment" && message.payload && message.payload.inputs) {
              _.each(message.payload.inputs, function (input) {
                var key = utxoKey(input);
                lockedInputs.push(key);
                if (utxoIndex[key]) {
                  utxoIndex[key].locked = true;
                }
              });
            }
          });
        });

        log.debug(`Got  ${lockedInputs.length} locked UTXOs`);
        return next();
      });
    },

    function (next) {
      var now = Math.floor(Date.now() / 1000);
      // Fetch latest broadcasted txs and remove any spent inputs from the
      // list of UTXOs returned by the block explorer. This counteracts any out-of-sync
      // effects between broadcasting a tx and getting the list of UTXOs.
      // This is especially true in the case of having multiple instances of the block explorer.
      self.storage.fetchBroadcastedTxs(self.walletId, {
        minTs: now - 24 * 3600,
        limit: 100
      }, function (err, txs) {
        if (err) return next(err);
        var spentInputs = [];

        _.each(txs, function(tx) {
          _.each(tx.unit.messages, function (message) {
            if (message.app == "payment" && message.payload && message.payload.inputs) {
              _.each(message.payload.inputs, function (input) {
                var key = utxoKey(input);
                spentInputs.push(key);
                if (utxoIndex[key]) {
                  utxoIndex[key].spent = true;
                }
              });
            }
          });
        });

        allUtxos = _.reject(allUtxos, {
          spent: true
        });
        log.debug(`Got ${allUtxos.length} usable UTXOs`);
        return next();
      });
    },

    function (next) {
      // Needed for the clients to sign UTXOs
      var addressToPath = _.keyBy(allAddresses, 'address');
      _.each(allUtxos, function (utxo) {
        if (!addressToPath[utxo.address]) {
          if (!opts.addresses)
            log.warn('Ignored UTXO!: ' + utxo.address);
          return;
        }
        utxo.path = addressToPath[utxo.address].path;
        utxo.definition = addressToPath[utxo.address].definition;
      });
      return next();
    },
  ], function (err) {
    return cb(err, allUtxos);
  });
};

/**
 * Returns list of UTXOs
 * @param {Object} opts
 * @param {Array} opts.addresses [Optional] - List of addresses.
 * @param {String} opts.asset [Optional] - Asset unit id. 'all' for all, null and 'base' and 'bytes' for bytes. (defaults to 'all').
 * @returns {Array} utxos - List of UTXOs.
 */
WalletService.prototype.getUtxos = function (opts, cb) {
  var self = this;

  opts = opts || {};

  if (!Utils.checkAsset(opts.asset, cb)) {
    return;
  }

  if (opts.addresses) {
    blockchainExplorer.getUtxos(opts.addresses, opts.asset, (err, utxos) => {
      if (err) return cb(err);
      return cb(null, utxos);
    });
  } else {
    self._getUtxosForCurrentWallet(opts, cb);
  }
};

WalletService.prototype._processBalances = function (balances, cb) {
  var self = this;

  async.each(Object.keys(balances), function(asset, next) {
    if (asset == 'base') {
      balances[asset].decimals = 0;
      balances[asset].ticker = 'BYTES';
      next();
    } else {
      self.storage.fetchAssetByUnit(asset, function (err, result) {
        if (err || _.isEmpty(result)) return next();
        balances[asset].decimals = result[0].decimals;
        balances[asset].ticker = result[0].ticker;
        next();
      });
    }
  }, function () {
    cb(null, balances);
  });
};

/**
 * Get wallet balance.
 * @param {Object} opts
 * @param {Array} opts.addresses [Optional] - List of addresses. null for all addresses in wallet. (defaults to null).
 * @param {String} opts.asset [Optional] - Asset. 'all' for all assets, null and 'base' and 'bytes' for bytes. (defaults to 'all').
 * @returns {Object} balance - Total amount & pending amount.
 */
WalletService.prototype.getBalance = function (opts, cb) {
  var self = this;
  opts = opts || {};

  if (!Utils.checkAsset(opts.asset, cb)) {
    return;
  }

  if (opts.addresses) {
    blockchainExplorer.getBalance(opts.addresses, opts, function (err, balances) {
      if (err) return cb(err);
      self._processBalances(balances, cb);
    });
  } else {
    self.getWallet({}, function(err, wallet){
      if (err) return cb(err);

      if (wallet.scanStatus == 'error') 
        return cb(Errors.WALLET_NEED_SCAN);

      self.storage.fetchAddresses(self.walletId, function (err, addresses) {
        if (err) return cb(err);
        if (_.isEmpty(addresses)) return cb(null, { base: { stable: 0, pending: 0, stable_outputs_count: 0, pending_outputs_count: 0 } });
        var addressesStr = _.map(addresses, 'address');
        blockchainExplorer.getBalance(addressesStr, opts, function (err, balances) {
          if (err) return cb(err);
          self._processBalances(balances, cb);
        });
      });
    });
  }
};

WalletService.prototype._getSigner = function (wallet) {
  var self = this;

	return {
		readSigningPaths: function (address, handleLengthsBySigningPaths) { 
      self.storage.fetchAddressByWalletId(self.walletId, address, function (err, result) {
        if (err) handleLengthsBySigningPaths(err);
        if (!result) handleLengthsBySigningPaths(Errors.ADDRESS_NOT_FOUND);
				var assocLengthsBySigningPaths = {};
        for (var i in result.signingPaths) {
          var signing_path = result.signingPaths[i];
          assocLengthsBySigningPaths[signing_path] = OcoreConstants.SIG_LENGTH;
          if (Object.keys(assocLengthsBySigningPaths).length >= wallet.m) break;
        }
        var addressInfo = _.pick(result, ['walletId', 'path', 'signingPaths']);
        handleLengthsBySigningPaths(null, assocLengthsBySigningPaths, addressInfo);
      });
		},
		readDefinition: function (address, handleDefinition) {
      self.storage.fetchAddressByWalletId(self.walletId, address, function (err, result) {
        if (err) handleDefinition(err);
        if (!result) handleDefinition(Errors.ADDRESS_NOT_FOUND);
        handleDefinition(null, result.definition);
      });
		}
	}
};

WalletService.prototype._canCreateTx = function (cb) {
  var self = this;
  self.storage.fetchLastTxs(self.walletId, self.copayerId, 5 + Defaults.BACKOFF_OFFSET, function (err, txs) {
    if (err) return cb(err);

    if (!txs.length)
      return cb(null, true);

    var lastRejections = _.takeWhile(txs, {
      status: 'rejected'
    });

    var exceededRejections = lastRejections.length - Defaults.BACKOFF_OFFSET;
    if (exceededRejections <= 0)
      return cb(null, true);


    var lastTxTs = txs[0].createdOn;
    var now = Math.floor(Date.now() / 1000);
    var timeSinceLastRejection = now - lastTxTs;
    var backoffTime = Defaults.BACKOFF_TIME;

    if (timeSinceLastRejection <= backoffTime)
      self.logi('Not allowing to create TX: timeSinceLastRejection/backoffTime', timeSinceLastRejection, backoffTime);

    return cb(null, timeSinceLastRejection > backoffTime);
  });
};

WalletService.prototype._validateOutputs = function (opts, cb) {
  if (_.isEmpty(opts.outputs)) {
    return new ClientError('No outputs were specified');
  }

  for (var i = 0; i < opts.outputs.length; i++) {
    var output = opts.outputs[i];

    if (!ValidationUtils.isValidAddress(output.address)) {
      return Errors.INVALID_ADDRESS;
    }

    if (!Utils.checkRequired(output, ['address', 'amount'])) {
      return new ClientError('Argument missing in output #' + (i + 1) + '.');
    }

    if (!_.isNumber(output.amount) || _.isNaN(output.amount) || output.amount <= 0 || output.amount > OcoreConstants.TOTAL_WHITEBYTES) {
      return new ClientError('Invalid amount');
    }

    opts.outputs[i] = _.pick(output, 'address', 'amount')
  }
  return null;
};

WalletService.prototype._validateAndSanitizeTxOpts = function (wallet, opts, cb) {
  var self = this;

  switch (opts.app) {
    case "payment":
      async.series(
        [
          function(next) {
            if (!Utils.checkAsset(opts.params.asset, next)) {
              return next(new ClientError("Invalid asset."));
            }
            next();
          },
          function(next) {
            if (wallet.singleAddress && opts.params.change_address)
              return next(
                new ClientError(
                  "Cannot specify change address on single-address wallet"
                )
              );
            next();
          },
          function(next) {
            var validationError = self._validateOutputs(opts.params, wallet, next);
            if (validationError) {
              return next(validationError);
            }
            next();
          }
        ],
        cb
      );
      break;

    case "data":
      if (_.isEmpty(opts.params) || !_.isPlainObject(opts.params)) {
        return cb(new ClientError("Invalid params"));
      }
      cb();
      break;

    case "text":
      if (_.isEmpty(opts.params) || !_.isString(opts.params)) {
        return cb(new ClientError("Invalid params"));        
      }
      cb();
      break;

    case "profile":
      if (_.isEmpty(opts.params) || !_.isPlainObject(opts.params)) {
        return cb(new ClientError("Invalid params"));
      }
      cb();
      break;

    case "poll":
      if (!Utils.checkRequired(opts.params, ['questions', 'choices'], cb)) {
        return cb(new ClientError("Required params missing"));
      }
      cb();
      break;

    case "vote":
      if (!Utils.checkRequired(opts.params, ['unit', 'choice'], cb)) {
        return cb(new ClientError("Required params missing"));
      }
      if (!ValidationUtils.isValidBase64(opts.params.unit, OcoreConstants.HASH_LENGTH)) {
        return cb(new ClientError("Invalid unit"));
      }
      cb();
      break;

    case "data_feed":
      if (_.isEmpty(opts.params) || !_.isPlainObject(opts.params)) {
        return cb(new ClientError("Invalid params"));
      }
      cb();
      break;

    case "attestation":
      if (!Utils.checkRequired(opts.params, ['address', 'profile'], cb)) {
        return cb(new ClientError("Required params missing"));
      }
      if (!ValidationUtils.isValidAddress(opts.params.address)) {
        return cb(new ClientError("Invalid address"));
      }
      if (!_.isPlainObject(opts.params.profile)) {
        return cb(new ClientError("Invalid profile"));
      }
      cb();
      break;

    case "asset":
      if (!Utils.checkRequired(opts.params, ['is_private', 'is_transferrable', 'auto_destroy', 'fixed_denominations', 'issued_by_definer_only', 'spender_attested'], cb)) {
        return cb(new ClientError("Required params missing"));
      }
      cb();
      break;

    case "asset_attestors":
      if (!Utils.checkRequired(opts.params, ['asset', 'attestors'], cb)) {
        return cb(new ClientError("Required params missing"));
      }
      if (!ValidationUtils.isValidBase64(opts.params.asset, OcoreConstants.HASH_LENGTH)) {
        return cb(new ClientError("Invalid asset"));
      }
      if (!ValidationUtils.isNonemptyArray(opts.params.attestors)) {
        return cb(new ClientError("Attestors must be non-empty array"));
      }
      if (!opts.params.attestors.every(ValidationUtils.isValidAddress)) {
        return cb(new ClientError("Some attestors are not valid"));
      }
      cb();
      break;

    case "address_definition_change":
      if (!Utils.checkRequired(opts.params, ['definition_chash', 'address'], cb)) {
        return cb(new ClientError("Required params missing"));
      }
      if (!ValidationUtils.isValidAddress(opts.params.address)) {
        return cb(new ClientError("Invalid address"));
      }
      cb();
      break;

    case "definition_template":
      if (_.isEmpty(opts.params) || !_.isArray(opts.params)) {
        return cb(new ClientError("Invalid params"));
      }
      cb();
      break;

    default:
      return cb(new ClientError("Invalid app type"));
  }
};

WalletService.prototype._sendMultiPayment = function (wallet, opts, cb) {
  var self = this;

  var asset = null;
  if (opts.params.asset && ValidationUtils.isValidBase64(opts.params.asset, OcoreConstants.HASH_LENGTH)) {
    asset = opts.params.asset;
  }

  if (opts.app == 'payment') {
    opts.params.asset = asset;
    opts.params.change_address = opts.changeAddress.address;
  } 

  var txp;

  self.storage.fetchAddresses(self.walletId, function (err, addresses) {
    if (err) return next(err);
    if (_.isEmpty(addresses)) return next(Errors.ADDRESS_NOT_FOUND);
    var addressesStr = _.map(addresses, 'address');

    var params = {
      asset: asset,
      available_paying_addresses: addressesStr,
      spend_unconfirmed: opts.params.spend_unconfirmed || 'own',
      signer: self._getSigner(wallet),
      callbacks: {
        ifNotEnoughFunds: function(err) {
          return cb(err);
        },
        ifError: function(err) {
          return cb(err);
        },
        ifOk: function(objJoint, unlock) {
          unlock();
          var txOpts = {
            id: opts.txProposalId,
            walletId: self.walletId,
            creatorId: self.copayerId,
            coin: wallet.coin,
            network: wallet.network,
            message: opts.message,
            app: opts.app,
            params: opts.params,
            walletM: wallet.m,
            walletN: wallet.n,
            changeAddress: opts.changeAddress.address,
            addressType: wallet.addressType,
            customData: opts.customData,
            unit: objJoint.unit,
            signingInfo: objJoint.signingInfo
          };
          txp = Model.TxProposal.create(txOpts);
          return cb(null, txp);
        }
      }
    };

    if (opts.payload) {
      params.messages = [opts.payload];
    }

    if (asset) {
      if (opts.params.send_all) return next('send all with asset');
      params.available_fee_paying_addresses = addressesStr;
      params.asset_outputs = opts.params.outputs;
      params.change_address = opts.changeAddress.address;
      OcoreStorage.readAsset(OcoreDb, asset, null, function(err, objAsset){
        if (err) return next(err);
        if (objAsset.is_private) return next('private asset is not supported');
  
        if (objAsset.fixed_denominations) { // indivisible
          params.tolerance_plus = 0;
          params.tolerance_minus = 0;
          IndivisibleAsset.composeMinimalIndivisibleAssetPaymentJoint(params);
        } else { // divisible
          DivisibleAsset.composeMinimalDivisibleAssetPaymentJoint(params);
        }
      });
    } else { // base asset
      if (opts.app == 'payment') {
        params.outputs = opts.params.outputs;
      } else {
        params.outputs = [];
      }

      if (opts.params.send_all) {
        params.send_all = opts.params.send_all;
        opts.params.outputs = [{address: opts.params.outputs[0].address, amount: 0}];
        params.outputs = opts.params.outputs;
      } else {
        params.outputs.push({address: opts.changeAddress.address, amount: 0});
      }
      Composer.composeMinimalJoint(params);
    }
  });
}

WalletService.prototype._createTx = function (wallet, opts, cb) {
  var self = this;

  switch (opts.app) {
    case "payment":
      break;

    case "data":
    case "text":
    case "profile":
    case "poll":
    case "vote":
    case "data_feed":
    case "attestation":
    case "asset":
    case "asset_attestors":
    case "address_definition_change":
    case "definition_template":
      opts.payload = {
        app: opts.app,
        payload_location: 'inline',
        payload_hash: ObjectHash.getBase64Hash(opts.params, OcoreStorage.getMinRetrievableMci() >= OcoreConstants.timestampUpgradeMci),
        payload: opts.params
      };
      break;

    default:
      return cb(new ClientError("Invalid app type"));
  }

  self._sendMultiPayment(wallet, opts, cb);
};

/**
 * Create a transaction proposal
 *
 * @param {Object} opts
 * @param {String} opts.txProposalId [Optional] - If provided it will be used as this TX proposal ID. Should be unique in the scope of the wallet.
 * @param {String} opts.app [Required] - Transaction proposal type. (defaults to 'payment', others include 'text', 'data', 'data feed', 'profile', 'poll', 'vote', etc.)
 * @param {Object} opts.params [Required] - Params for app.
 * @param {String} opts.message [Optional] - A message to attach to this transaction.
 * @param {Boolean} opts.dryRun [Optional] - Simulate the action but do not change server state.
 * @returns {Callback} cb - Return error or the transaction proposal.
 *
 * app: payment
 * @param {String} opts.params.asset [Optional] - Hash of unit where the asset was defined. (defaults to null).
 * @param {Array} opts.params.outputs [Required] - List of outputs.
 * @param {String} opts.params.outputs[].address [Required] - Destination address.
 * @param {Number} opts.params.outputs[].amount [Required] - Amount to transfer.
 * @param {Array} opts.params.inputs [Optional] - Inputs for this TX
 * @param {String} opts.params.change_address [Optional] - Use this address as the change address for the tx. The address should belong to the wallet. In the case of singleAddress wallets, the first main address will be used.
 * @param {Boolean} opts.params.send_all [Optional] - Send maximum amount of bytes. (defaults to false).
 * @param {Boolean} opts.params.spend_unconfirmed [Optional] - UTXOs of unconfirmed transactions as inputs. (defaults to 'own', others include 'all', 'none')
 * @param {Object} opts.payload [Optional] - Extra messages to sent.
 * 
 * app: data - One can store arbitrary structured data using 'data' message type.
 * @param {Object} opts.params [Required] - Structured data of key-value
 *
 * app: text - One can store arbitrary texts using 'text' message type.
 * @param {String} opts.params [Required] - Text to store.
 *
 * app: profile - Users can store their profiles on Obyte if they want.
 * @param {Object} opts.params [Required] - Profile data of key-value.
 *
 * app: poll - Anyone can set up a poll by sending a message with app='poll'.
 * @param {String} opts.params.questions [Required] - Question of the poll.
 * @param {Array} opts.params.choices [Required] - Allowed set of choices.
 *
 * app: vote - To cast votes, users send 'vote' messages.
 * @param {String} opts.params.unit [Required] - Hash of unit where the poll was defined.
 * @param {String} opts.params.choice [Required] - Indicate what the user want to vote for. The choice must be defined in the poll message.
 *
 * app: data_feed - Data fields can be used to design definitions that involve oracles.
 * @param {Object} opts.params [Required] - Data feed of key-value.
 *
 * app: attestation - Attestations confirm that the user who issued the attestation (the attestor) verified some data about the attested user (the subject).
 * @param {String} opts.params.address [Required] - Address of the attested user (the subject).
 * @param {Object} opts.params.profile [Required] - Verified data about the attested user.
 *
 * app: asset - Assets in OByte can be issued, transferred, and exchanged, and.they behave similarly to the native currency 'bytes'.
 * @param {Number} opts.params.cap [Optional] - Is the total number of coins that can be issued (money supply). If omitted, the number is unlimited.
 * @param {Boolean} opts.params.is_private [Required] - Indicates whether the asset is private (such as blackbytes) or publicly traceable (similar to bytes).
 * @param {Boolean} opts.params.is_transferrable [Required] - Indicates whether the asset can be freely transferred among arbitrary parties or all transfers should involve the definer address as either sender or recipient. The latter can be useful e.g. for loyalty points that cannot be resold.
 * @param {Boolean} opts.params.auto_destroy [Required] - Indicates whether the asset is destroyed when it is sent to the definer address.
 * @param {Boolean} opts.params.fixed_denominations [Required] - Indicates whether the asset exists as coins (banknotes) of a limited set of denominations, similar to blackbytes. If it is true, the definition must also include property denominations, which is an array of all denominations and the number of coins of that denomination.
 * @param {Array} opts.params.denominations [Optional] - Optional. Array of all denominations and the number of coins of that denomination.
 * @param {Boolean} opts.params.issued_by_definer_only [Required] - Indicates whether the asset can be issued only by the definer address. If false, anyone can issue the asset, in this case cap must be unlimited.
 * @param {Boolean} opts.params.cosigned_by_definer [Required] - Indicates whether each operation with the asset must be cosigned by the definer address. Useful for regulated assets where the issuer (bank) wants to perform various compliance checks (such as the funds are not arrested by a court order) prior to approving a transaction.
 * @param {Boolean} opts.params.spender_attested [Required] - Indicates whether the spender of the asset must be attested by one of approved attestors. Also useful for regulated assets e.g. to limit the access to the asset only to KYC'ed users. If true, the definition must also include the list of approved attestor addresses.
 * @param {Array} opts.params.attestors [Optional] - List of approved attestor addresses
 * @param {Array} opts.params.issue_condition [Optional] - Specify the restrictions when the asset can be issued. It evaluate to a boolean and are coded in the same smart contract language as address definitions.
 * @param {Array} opts.params.transfer_condition [Optional] - Specify the restrictions when the asset can be transferred. It evaluate to a boolean and are coded in the same smart contract language as address definitions.
 *
 * app: asset_attestors - The list of an asset attestors can be amended by the definer by sending an 'asset_attestors' message that replaces the list of attestors.
 * @param {String} opts.params.asset [Required] - Asset unit id.
 * @param {Array} opts.params.attestors [Required] - List of approved attestor addresses.
 *
 * app: address definition change - Users can update definitions of their addresses while keeping the old address.
 * @param {String} opts.params.definition_chash [Required] - Indicates the checksummed hash of the new address definition.
 * @param {String} opts.params.address [Optional] - When multi-authored, must indicate address.
 *
 * app: definition_template - The template looks like normal definition but may include references to variables in the syntax @param1, @param2. Definition templates enable code reuse. They may in turn reference other templates.
 * @param {Array} opts.params [Required] - Definition template.
 *
 * For test mode
 * @param {Boolean} opts.testRun [Optional] - Add transaction proposal for test mode.
 * @param {Object} opts.unit [Optional] - Unit data for test mode.
 * @param {Object} opts.signingInfo [Optional] - Signing information for test mode.
 *
 */
WalletService.prototype.createTx = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['app', 'params'], cb)) {
    return;
  }

  function checkTxpAlreadyExists(txProposalId, cb) {
    if (!txProposalId) return cb();
    self.storage.fetchTx(self.walletId, txProposalId, cb);
  };

  function getChangeAddress(wallet, cb) {
    if (wallet.singleAddress) {
      self.storage.fetchAddresses(self.walletId, function (err, addresses) {
        if (err) return cb(err);
        if (_.isEmpty(addresses)) return cb(new ClientError('The wallet has no addresses'));
        return cb(null, _.head(addresses));
      });
    } else {
      if (opts.app == 'payment' && opts.params.change_address) {
        if (!ValidationUtils.isValidAddress(opts.params.change_address)) return cb(addrErr);

        self.storage.fetchAddressByWalletId(wallet.id, opts.params.change_address, function (err, address) {
          if (err || !address) return cb(Errors.INVALID_CHANGE_ADDRESS);
          return cb(null, address);
        });
      } else {
        self.storage.fetchNoActivityAddresses(wallet.id, true, function (err, addresses) {
          if (err) return cb(err);
          if (_.isEmpty(addresses)) {
            return cb(null, wallet.createAddress(true), true);
          } else {
            return cb(null, _.head(addresses));
          }
        })
      }
    }
  };

  self._runLocked(cb, function (cb) {
    var txp, changeAddress, isNewAddress;
    self.getWallet({}, function (err, wallet) {
      if (err) return cb(err);
      if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);

      if (wallet.scanStatus == 'error')
        return cb(Errors.WALLET_NEED_SCAN);

      checkTxpAlreadyExists(opts.txProposalId, function (err, tx) {
        if (err) return cb(err);
        if (tx && tx.status != 'temporary') return cb(null, tx);

        async.series([

          function (next) {
            self._validateAndSanitizeTxOpts(wallet, opts, next);
          },

          function (next) {
            self._canCreateTx(function (err, canCreate) {
              if (err) return next(err);
              if (!canCreate) return next(Errors.TX_CANNOT_CREATE);
              next();
            });
          },

          function (next) {
            if (opts.app == 'payment' && opts.params.send_all) {
              changeAddress = {address: null};
              isNewAddress = false;
              opts.changeAddress = changeAddress;
              return next()
            } else {
              getChangeAddress(wallet, function (err, address, isNew) {
                if (err) return next(err);
                changeAddress = address;
                isNewAddress = isNew;
                opts.changeAddress = changeAddress;
                return next();
              });
            }
          },

          function (next) {
            if (opts.testRun) {
              var txOpts = {
                id: opts.txProposalId,
                walletId: self.walletId,
                creatorId: self.copayerId,
                coin: wallet.coin,
                network: wallet.network,
                message: opts.message,
                app: opts.app,
                params: opts.params,
                walletM: wallet.m,
                walletN: wallet.n,
                changeAddress: changeAddress.address,
                addressType: wallet.addressType,
                customData: opts.customData,
                unit: opts.unit,
                signingInfo: opts.signingInfo
              };
              txp = Model.TxProposal.create(txOpts);
              return next();
            }

            self._createTx(wallet, opts, function (err, result) {
              if (err) return next(err);
              txp = result;
              next();
            });
          },

          function (next) {
            if (!isNewAddress || !changeAddress || wallet.singleAddress || opts.dryRun) return next();
            changeAddress.hasActivity = true;
            self._store(wallet, changeAddress, next);
          },

          function (next) {
            if (opts.dryRun) return next();
            self.storage.storeTx(wallet.id, txp, next);
          },
          
        ], function (err) {
          if (err) return cb(err);
          return cb(null, txp);
        });
      });
    });
  }, 10 * 1000);
};

WalletService.prototype._verifyRequestPubKey = function (requestPubKey, signature, xPubKey) {
  var pub = (new Bitcore.HDPublicKey(xPubKey)).deriveChild(Constants.PATHS.REQUEST_KEY_AUTH).publicKey;
  return Utils.verifyMessage(requestPubKey, signature, pub.toString());
};

/**
 * Publish an already created tx proposal so inputs are locked and other copayers in the wallet can see it.
 * @param {Object} opts
 * @param {String} opts.txProposalId [Required] - The tx id.
 * @param {String} opts.proposalSignature [Required] - S(raw tx). Used by other copayers to verify the proposal.
 */
WalletService.prototype.publishTx = function (opts, cb) {
  var self = this;

  function utxoKey(utxo) {
    return utxo.unit + '|' + utxo.message_index + '|' + utxo.output_index;
  };

  if (!Utils.checkRequired(opts, ['txProposalId', 'proposalSignature'], cb)) return;
  opts.testRun = opts.testRun | false;

  self._runLocked(cb, function (cb) {
    self.getWallet({}, function (err, wallet) {
      if (err) return cb(err);

      self.storage.fetchTx(self.walletId, opts.txProposalId, function (err, txp) {
        if (err) return cb(err);
        if (!txp) return cb(Errors.TX_NOT_FOUND);
        if (!txp.isTemporary()) return cb(null, txp);

        var copayer = wallet.getCopayer(self.copayerId);
        var raw = ObjectHash.getUnitHashToSign(txp.unit);

        var signingKey = self._getSigningKey(raw, opts.proposalSignature, copayer.requestPubKeys);
        if (!signingKey) {
          return cb(new ClientError('Invalid proposal signature'));
        }

        // Save signature info for other copayers to check
        txp.proposalSignature = opts.proposalSignature;
        if (signingKey.selfSigned) {
          txp.proposalSignaturePubKey = signingKey.key;
          txp.proposalSignaturePubKeySig = signingKey.signature;
        }

        // Verify UTXOs are still available
        log.debug('Rechecking UTXOs availability for publishTx');

        self._getUtxosForCurrentWallet({}, function (err, utxos) {
          if (err) return cb(err);

          var txpInputs = [];
          for (const msg of txp.unit.messages) {
            if (msg.app == 'payment') {
              for (const input of msg.payload.inputs) {
                if (input.unit && input.message_index && input.output_index)
                  txpInputs.push(utxoKey(input));
              }
            }
          }

          var utxosIndex = _.keyBy(utxos, utxoKey);
          var unavailable = _.some(txpInputs, function (i) {
            var utxo = utxosIndex[i];
            return !utxo || utxo.locked;
          });

          if (unavailable) return cb(Errors.UNAVAILABLE_UTXOS);

          txp.status = 'pending';
          self.storage.storeTx(self.walletId, txp, function (err) {
            if (err) return cb(err);

            self._notifyTxProposalAction('NewTxProposal', txp, function () {
              return cb(null, txp);
            });
          });
        });
      });
    });
  });
};

/**
 * Retrieves a tx from storage.
 * @param {Object} opts
 * @param {String} opts.txProposalId [Required] - The tx proposal id.
 * @returns {Object} txProposal
 */
WalletService.prototype.getTx = function (opts, cb) {
  var self = this;

  self.storage.fetchTx(self.walletId, opts.txProposalId, function (err, txp) {
    if (err) return cb(err);
    if (!txp) return cb(Errors.TX_NOT_FOUND);

    if (!txp.txid) return cb(null, txp);

    self.storage.fetchTxNote(self.walletId, txp.txid, function (err, note) {
      if (err) {
        self.logw('Error fetching tx note for ' + txp.txid);
      }
      txp.note = note;
      return cb(null, txp);
    });
  });
};


/**
 * Retrieves a unit from ocore storage.
 * @param {Object} opts
 * @param {String} opts.txid [Required] - The tx unit id.
 * @returns {Object} unit
 */
WalletService.prototype.getRawTx = function (opts, cb) {
	OcoreStorage.readJoint(OcoreDb, opts.txid, {
		ifNotFound: function(){
			return cb(new ClientError("unit "+opts.txid+" not found"));
		},
		ifFound: function(objJoint){
      return cb(null, objJoint.unit);
    }
  });
};

/**
 * Edit note associated to a txid.
 * @param {Object} opts
 * @param {String} opts.txid [Required] - The txid of the tx on the blockchain.
 * @param {String} opts.body [Required] - The contents of the note.
 */
WalletService.prototype.editTxNote = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, 'txid', cb)) return;

  self._runLocked(cb, function (cb) {
    self.storage.fetchTxNote(self.walletId, opts.txid, function (err, note) {
      if (err) return cb(err);

      if (!note) {
        note = Model.TxNote.create({
          walletId: self.walletId,
          txid: opts.txid,
          copayerId: self.copayerId,
          body: opts.body,
        });
      } else {
        note.edit(opts.body, self.copayerId);
      }
      self.storage.storeTxNote(note, function (err) {
        if (err) return cb(err);
        self.storage.fetchTxNote(self.walletId, opts.txid, cb);
      });
    });
  });
};

/**
 * Get tx notes.
 * @param {Object} opts
 * @param {String} opts.txid [Required] - The txid associated with the note.
 */
WalletService.prototype.getTxNote = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, 'txid', cb)) return;
  self.storage.fetchTxNote(self.walletId, opts.txid, cb);
};

/**
 * Get tx notes.
 * @param {Object} opts
 * @param {String} opts.minTs [Optional] - The start date used to filter notes. (defaults to 0).
 */
WalletService.prototype.getTxNotes = function (opts, cb) {
  var self = this;

  opts = opts || {};
  self.storage.fetchTxNotes(self.walletId, opts, cb);
};

/**
 * removeWallet
 *
 * @param opts
 * @param cb
 * @return {undefined}
 */
WalletService.prototype.removeWallet = function (opts, cb) {
  var self = this;

  self._runLocked(cb, function (cb) {
    self.storage.removeWallet(self.walletId, cb);
  });
};

WalletService.prototype.getRemainingDeleteLockTime = function (txp) {
  var now = Math.floor(Date.now() / 1000);

  var lockTimeRemaining = txp.createdOn + Defaults.DELETE_LOCKTIME - now;
  if (lockTimeRemaining < 0)
    return 0;

  // not the creator? need to wait
  if (txp.creatorId !== this.copayerId)
    return lockTimeRemaining;

  // has other approvers? need to wait
  var approvers = txp.getApprovers();
  if (approvers.length > 1 || (approvers.length == 1 && approvers[0] !== this.copayerId))
    return lockTimeRemaining;

  return 0;
};

/**
 * removePendingTx
 *
 * @param opts
 * @param {String} opts.txProposalId [Required] - The tx id.
 * @return {undefined}
 */
WalletService.prototype.removePendingTx = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['txProposalId'], cb)) return;

  self._runLocked(cb, function (cb) {

    self.getTx({
      txProposalId: opts.txProposalId,
    }, function (err, txp) {
      if (err) return cb(err);

      if (!txp.isPending()) return cb(Errors.TX_NOT_PENDING);

      var deleteLockTime = self.getRemainingDeleteLockTime(txp);
      if (deleteLockTime > 0) return cb(Errors.TX_CANNOT_REMOVE);

      self.storage.removeTx(self.walletId, txp.id, function () {
        self._notifyTxProposalAction('TxProposalRemoved', txp, cb);
      });
    });
  });
};

/**
 * Broadcast a raw transaction.
 * @param {Object} opts
 * @param {String} opts.coin [Optional] - The coin for this transaction. (defaults to 'obyte').
 * @param {String} opts.network [Optional] - The network for this transaction. (defaults to 'livenet').
 * @param {String} opts.joint [Required] - Raw joint data.
 */
WalletService.prototype.broadcastJoint = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['joint'], cb)) return;

  opts.coin = opts.coin || Defaults.COIN;
  if (!Utils.checkValueInCollection(opts.coin, Constants.COINS))
    return cb(new ClientError('Invalid coin'));

  opts.network = opts.network || 'livenet';
  if (!Utils.checkValueInCollection(opts.network, Constants.NETWORKS))
    return cb(new ClientError('Invalid network'));

  blockchainExplorer.broadcastJoint(opts.joint, cb);
};

WalletService.prototype._checkTxInBlockchain = function (txp, cb) {
  if (!txp.txid) return cb();
  blockchainExplorer.getTransaction(txp.txid, function (err, tx) {
    if (err) return cb(err);
    return cb(null, !!tx);
  });
};

/**
 * Sign a transaction proposal.
 * @param {Object} opts
 * @param {String} opts.txProposalId [Required] - The identifier of the transaction.
 * @param {String} opts.signatures [Required] - The signatures of the inputs of this tx for this copayer (in apperance order)
 */
WalletService.prototype.signTx = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['txProposalId', 'signatures'], cb)) return;

  self._runLocked(cb, function (cb) {
    self.getWallet({}, function (err, wallet) {
      if (err) return cb(err);

      self.getTx({
        txProposalId: opts.txProposalId
      }, function (err, txp) {
        if (err) return cb(err);

        var action = _.find(txp.actions, {
          copayerId: self.copayerId
        });
        if (action) return cb(Errors.COPAYER_VOTED);
        if (!txp.isPending()) return cb(Errors.TX_NOT_PENDING);
        if (txp.isAccepted()) return cb(Errors.TX_ALREADY_ACCEPTED);

        var copayer = wallet.getCopayer(self.copayerId);

        try {
          if (!txp.sign(self.copayerId, self.walletId, opts.signatures, copayer.xPubKey)) {
            self.logw('Error signing transaction (BAD_SIGNATURES)');
            self.logw('Client version:', self.clientVersion);
            self.logw('Arguments:', JSON.stringify(opts));
            self.logw('Transaction proposal:', JSON.stringify(txp));
            return cb(Errors.BAD_SIGNATURES);
          }
        } catch (ex) {
          self.logw('Error signing transaction proposal', ex);
          return cb(ex);
        }

        self.storage.storeTx(self.walletId, txp, function (err) {
          if (err) return cb(err);

          async.series([

            function (next) {
              self._notifyTxProposalAction('TxProposalAcceptedBy', txp, {
                copayerId: self.copayerId,
              }, next);
            },
            function (next) {
              if (txp.isAccepted()) {
                self._notifyTxProposalAction('TxProposalFinallyAccepted', txp, next);
              } else {
                next();
              }
            },
          ], function () {
            return cb(null, txp);
          });
        });
      });
    });
  });
};

WalletService.prototype._storeActiveAddresses = function(addresses, cb) {
  var self = this;

  self.storage.markActiveAddresses(addresses, function() {
    if (cb) return cb();
  });
};

WalletService.prototype._processBroadcast = function (txp, opts, cb) {
  var self = this;
  $.checkState(txp.txid);
  opts = opts || {};

  txp.setBroadcasted();
  self.storage.storeTx(self.walletId, txp, function (err) {
    if (err) return cb(err);

    var extraArgs = {
      txid: txp.txid,
    };
    if (opts.byThirdParty) {
      self._notifyTxProposalAction('NewOutgoingTxByThirdParty', txp, extraArgs);
    } else {
      self._notifyTxProposalAction('NewOutgoingTx', txp, extraArgs);
    }

    var authorAddresses = txp.getUnitAuthors();
    var outputs = txp.getUnitOutputs();
    var outputAddresses = outputs.map(function(output){ return output.address; });
    self._storeActiveAddresses(_.union(authorAddresses, outputAddresses), function () {
      return cb(null, txp);
    });
  });
};

/**
 * Broadcast a transaction proposal.
 * @param {Object} opts
 * @param {String} opts.txProposalId [Required] - The identifier of the transaction.
 */
WalletService.prototype.broadcastTx = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['txProposalId'], cb)) return;

  self.getWallet({}, function (err, wallet) {
    if (err) return cb(err);

    self.getTx({
      txProposalId: opts.txProposalId
    }, function (err, txp) {
      if (err) return cb(err);

      if (txp.status == 'broadcasted') return cb(Errors.TX_ALREADY_BROADCASTED);
      if (txp.status != 'accepted') return cb(Errors.TX_NOT_ACCEPTED);

      var objJoint = _.pick(txp, ['unit']);

      self.lock.runLocked(objJoint.unit.unit, {}, cb, function(cb) {
        blockchainExplorer.broadcastJoint(objJoint, function(err, result) {
          if (err) {
            var broadcastErr = err;
            self._checkTxInBlockchain(txp, function(err, isInBlockchain) {
              if (err) return cb(err);
              if (!isInBlockchain) return cb(broadcastErr);

              self._processBroadcast(txp, {
                byThirdParty: true
              }, cb);
            });
          } else {
            self._processBroadcast(txp, {
              byThirdParty: false
            }, cb);
          }
        });
      });
    });
  });
};

/**
 * Reject a transaction proposal.
 * @param {Object} opts
 * @param {String} opts.txProposalId [Required] - The identifier of the transaction.
 * @param {String} opts.reason [Optional] - A message to other copayers explaining the rejection.
 */
WalletService.prototype.rejectTx = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['txProposalId'], cb)) return;

  self.getTx({
    txProposalId: opts.txProposalId
  }, function (err, txp) {
    if (err) return cb(err);

    var action = _.find(txp.actions, {
      copayerId: self.copayerId
    });

    if (action) return cb(Errors.COPAYER_VOTED);
    if (txp.status != 'pending') return cb(Errors.TX_NOT_PENDING);

    txp.reject(self.copayerId, opts.reason);

    self.storage.storeTx(self.walletId, txp, function (err) {
      if (err) return cb(err);

      async.series([

        function (next) {
          self._notifyTxProposalAction('TxProposalRejectedBy', txp, {
            copayerId: self.copayerId,
          }, next);
        },

        function (next) {
          if (txp.status == 'rejected') {
            var rejectedBy = _.map(_.filter(txp.actions, {
              type: 'reject'
            }), 'copayerId');

            self._notifyTxProposalAction('TxProposalFinallyRejected', txp, {
              rejectedBy: rejectedBy,
            }, next);
          } else {
            next();
          }
        },

      ], function () {
        return cb(null, txp);
      });
    });
  });
};

/**
 * Retrieves pending transaction proposals.
 * @param {Object} opts
 * @returns {TxProposal[]} Transaction proposal.
 */
WalletService.prototype.getPendingTxs = function (opts, cb) {
  var self = this;

  self.storage.fetchPendingTxs(self.walletId, function (err, txps) {
    if (err) return cb(err);

    _.each(txps, function (txp) {
      txp.deleteLockTime = self.getRemainingDeleteLockTime(txp);
    });

    async.each(txps, function (txp, next) {
      if (txp.status != 'accepted') return next();

      self._checkTxInBlockchain(txp, function (err, isInBlockchain) {
        if (err || !isInBlockchain) return next(err);
        self._processBroadcast(txp, {
          byThirdParty: true
        }, next);
      });
    }, function (err) {

      txps = _.reject(txps, function (txp) {
        return txp.status == 'broadcasted';
      })

      return cb(err, txps);
    });
  });
};

/**
 * Retrieves all transaction proposals in the range (maxTs-minTs) Times are in UNIX EPOCH
 *
 * @param {Number} opts.minTs [Optional] - (defaults to 0)
 * @param {Number} opts.maxTs [Optional] - (defaults to now)
 * @param {Number} opts.limit [Optional] - (defaults to 10)
 * @param {String} opts.status [Optional] - (defaults to all)
 * @param {String} opts.app [Optional] - (defaults to all)
 * @param {Boolean} opts.isPending [Optional] - (defaults to false)
 * @returns {TxProposal[]} Transaction proposals, newer first
 */
WalletService.prototype.getTxs = function (opts, cb) {
  var self = this;
  opts = opts || {};

  if (!_.isUndefined(opts.minTs) && !_.isNumber(opts.minTs)) {
    return cb(new ClientError('Invalid minTs'));
  }

  if (!_.isUndefined(opts.maxTs) && !_.isNumber(opts.maxTs)) {
    return cb(new ClientError('Invalid maxTs'));
  }

  opts.limit = (_.isUndefined(opts.limit) ? 10 : opts.limit);
  if (!_.isUndefined(opts.limit) && !_.isNumber(opts.limit)) {
    return cb(new ClientError('Invalid limit'));
  }

  if (!_.isUndefined(opts.status) && !Utils.checkValueInCollection(opts.status, ['temporary', 'pending', 'accepted', 'broadcasted', 'rejected'])) {
    return cb(new ClientError('Invalid tx proposal status'));
  }

  self.storage.fetchTxs(self.walletId, opts, function (err, txps) {
    if (err) return cb(err);
    return cb(null, txps);
  });
};

/**
 * Retrieves notifications after a specific id or from a given ts (whichever is more recent).
 *
 * @param {Object} opts
 * @param {String} opts.notificationId [Optional]
 * @param {Number} opts.minTs [Optional] - default 0.
 * @returns {Notification[]} Notifications
 */
WalletService.prototype.getNotifications = function (opts, cb) {
  var self = this;
  opts = opts || {};

  self.getWallet({}, function (err, wallet) {
    if (err) return cb(err);

    async.map([wallet.network, self.walletId], function (walletId, next) {
      self.storage.fetchNotifications(walletId, opts.notificationId, opts.minTs || 0, next);
    }, function (err, res) {
      if (err) return cb(err);

      var notifications = _.sortBy(_.map(_.flatten(res), function (n) {
        n.walletId = self.walletId;
        return n;
      }), 'id');

      return cb(null, notifications);
    });
  });
};

WalletService._addProposalInfo = function (tx, indexedProposals) {
  var proposal = indexedProposals[tx.unit];
  if (proposal) {
    tx.createdOn = proposal.createdOn;
    tx.proposalId = proposal.id;
    tx.proposalType = proposal.type;
    tx.creatorName = proposal.creatorName;
    tx.message = proposal.message;
    tx.actions = _.map(proposal.actions, function (action) {
      return _.pick(action, ['createdOn', 'type', 'copayerId', 'copayerName', 'comment']);
    });
    tx.customData = proposal.customData;
  }
};

WalletService._addNotesInfo = function (tx, indexedNotes) {
  var note = indexedNotes[tx.unit];
  if (note) {
    tx.note = _.pick(note, ['body', 'editedBy', 'editedByName', 'editedOn']);
  }
};

/**
 * Retrieves all transactions (incoming & outgoing)
 * Times are in UNIX EPOCH
 *
 * @param {Object} opts
 * @param {String} opts.asset [Required] - Asset. null and 'base' and 'bytes' for bytes. (defaults to 'base').
 * @param {String} opts.addresses [Optional] - Addresses to be queried separated by.
 * @param {Number} opts.limit [Optional] - (defaults to 10)
 * @param {Number} opts.lastRowId [Optional] - Retrieve transactions from this row id.
 * @returns {TxProposal[]} Transaction proposals, first newer
 */
WalletService.prototype.getTxHistory = function (opts, cb) {
  var self = this;
  opts = opts || {};

  opts.asset = (_.isUndefined(opts.asset) || opts.asset == 'base') ? null : opts.asset;
  if (!Utils.checkAsset(opts.asset, cb)) {
    return;
  }

  opts.limit = (_.isUndefined(opts.limit) ? 10 : opts.limit);
  if (!ValidationUtils.isPositiveInteger(opts.limit))
    return cb(new ClientError('Invalid limit'));
  if (opts.limit > Defaults.HISTORY_LIMIT)
    return cb(Errors.HISTORY_LIMIT_EXCEEDED);

  if (opts.lastRowId && !ValidationUtils.isPositiveInteger(opts.lastRowId))
    return cb(new ClientError('Invalid row id'));

  async.waterfall([

    function (next) {
      if (opts.addresses) {
        blockchainExplorer.getTxHistory(opts.addresses, opts, function (err, txs) {
          if (err) return next(err);
          return next(null, txs);
        });
      } else {
        self.getWallet({}, function(err, wallet) {
          if (err) return next(err);
          if (wallet.scanStatus == 'error') 
            return next(Errors.WALLET_NEED_SCAN);
          if (wallet.scanStatus == 'running') 
            return next(Errors.WALLET_BUSY);
    
          self.storage.fetchAddresses(self.walletId, function (err, addresses) {
            if (err) return next(err);
            if (_.isEmpty(addresses)) return next(new ClientError('The wallet has no addresses'));
            var addressesStr = _.map(addresses, 'address');
            blockchainExplorer.getTxHistory(addressesStr, opts, function (err, txs) {
              if (err) return next(err);
              return next(null, txs);
            });
          });
        });
      }
    },

    function (txs, next) {
      async.each(txs, function(tx, next2) {
        if (tx.asset) {
          self.storage.fetchAssetByUnit(tx.asset, function (err, result) {
            if (err || _.isEmpty(result)) return next2();
            tx.decimals = result[0].decimals;
            tx.ticker = result[0].ticker;
            next2();
          });
        } else {
          tx.decimals = 0;
          tx.ticker = 'BYTES';
          next2();
        }
      }, function () {
        next(null, txs);
      });
    },

    function (txs, next) {
      if (!txs || _.isEmpty(txs))  {
        return next();
      }
      // TODO optimize this...
      // Fetch all proposals in [t - 7 days, t + 1 day]
      var minTs = _.minBy(txs, 'time').time - 7 * 24 * 3600;
      var maxTs = _.maxBy(txs, 'time').time + 1 * 24 * 3600;

      async.parallel([
        function(done) {
          self.storage.fetchTxs(self.walletId, {
            minTs: minTs,
            maxTs: maxTs
          }, done);
        },
        function(done) {
          self.storage.fetchTxNotes(self.walletId, {
            minTs: minTs
          }, done);
        },
      ], function(err, res) {
        return next(err, {
          txs: txs,
          txps: res[0],
          notes: res[1]
        });
      });      
    }, 

  ], function(err, res) {

    if (err) return cb(err);
    if (!res) return cb(null, []);

    // TODO we are indexing everything again, each query.
    var indexedProposals = _.keyBy(res.txps, 'txid');
    var indexedNotes = _.keyBy(res.notes, 'txid');

    var finalTxs =  _.map(res.txs, (tx) => {
      WalletService._addProposalInfo(tx, indexedProposals);
      WalletService._addNotesInfo(tx, indexedNotes);
      return tx;
    });
    return cb(null, finalTxs);

  });
};

/**
 * Scan the blockchain looking for addresses having some activity
 *
 * @param {Object} opts
 * @param {Boolean} opts.includeCopayerBranches [Optional] - (defaults to false)
 * @param {Boolean} opts.startingStep [Optional] - Estimate address number magniture (default to 1k), only for optimization.
 */
WalletService.prototype.scan = function (opts, cb) {
  var self = this;

  opts = opts || {};
  opts.startingStep = opts.startingStep || 1000;

  self.getWallet({}, function (err, wallet) {
    if (err) return cb(err);
    if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);

    // OCT2018: We dont allow copayer's BIP45 addr scanning anymore (for performance)
    // for BIP44 wallets.
    if (wallet.derivationStrategy === Constants.DERIVATION_STRATEGIES.BIP44) {
      opts.includeCopayerBranches = false;
    }

    // no powerScan when scanning copayer Branches
    if (opts.includeCopayerBranches) {
      opts.startingStep = 1;
    }

    self.storage.clearWalletCache(self.walletId, function () {
      self._runLocked(cb, function (cb) {
        wallet.scanStatus = 'running';
        self.storage.storeWallet(wallet, function (err) {
          if (err) return cb(err);

          var step = opts.startingStep;
          async.doWhilst(
            (next) => {
              self._runScan(wallet, step, opts, next)
            },
            () => {
              step = step / 10;
              return step >= 1;
            },
            cb
          );
        });
      });
    });
  });
};

WalletService.prototype._runScan = function (wallet, step, opts, cb) {
  var self = this;

  function scanBranch(wallet, derivator, cb) {
    var inactiveCounter = 0;
    var allAddresses = [];

    var gap = Defaults.SCAN_ADDRESS_GAP;

    //when powerScanning, we just accept gap<=3
    if (step > 1) {
      gap = _.min([gap, 3]);
    }

    async.whilst(function () {
      // self.logi('Scanning addr branch: %s index: %d gap %d step %d', derivator.id, derivator.index(), inactiveCounter, step);
      return inactiveCounter < gap;
    }, function (next) {
      var address = derivator.derive();

      blockchainExplorer.getAddressActivity(address.address, function (err, activity) {
        if (err) return next(err);
        self.logi('SCANING:' + address.address+ ':'+address.path + " :" + !!activity); //TODO
        
        address.hasActivity = !!activity;
        allAddresses.push(address);
        inactiveCounter = activity ? 0 : inactiveCounter + 1;
        return next();
      });
    }, function (err) {
      derivator.rewind(gap);
      return cb(err, _.dropRight(allAddresses, gap));
    });
  }

  var derivators = [];
  _.each([false, true], function (isChange) {
    derivators.push({
      id: wallet.addressManager.getBaseAddressPath(isChange),
      derive: _.bind(wallet.createAddress, wallet, isChange, step),
      index: _.bind(wallet.addressManager.getCurrentIndex, wallet.addressManager, isChange),
      rewind: _.bind(wallet.addressManager.rewindIndex, wallet.addressManager, isChange, step),
      getSkippedAddress: _.bind(wallet.getSkippedAddress, wallet),
    });

    if (opts.includeCopayerBranches) {
      _.each(wallet.copayers, function (copayer) {
        if (copayer.addressManager) {
          derivators.push({
            id: copayer.addressManager.getBaseAddressPath(isChange),
            derive: _.bind(copayer.createAddress, copayer, wallet, isChange),
            index: _.bind(copayer.addressManager.getCurrentIndex, copayer.addressManager, isChange),
            rewind: _.bind(copayer.addressManager.rewindIndex, copayer.addressManager, isChange, step),
          });
        }
      });
    }
  });

  async.eachSeries(derivators, function (derivator, next) {
    var addresses = [];
    scanBranch(wallet, derivator, function (err, scannedAddresses) {
      if (err) return next(err);
      addresses = addresses.concat(scannedAddresses);

      if (step > 1) {
        self.logi('Deriving addresses for scan steps gaps DERIVATOR:' + derivator.id);

        var addr, i = 0;
        while (addr = derivator.getSkippedAddress()) {
          addresses.push(addr);
          i++;
        }
        self.logi(i + ' addresses were added.');
      }

      async.each(addresses, function (address, next2) {
        blockchainExplorer.getAddressActivity(address.address, function (err, activity) {
          if (err) return next2(err);
          address.hasActivity = !!activity;
          return next2();
        });
      }, function (err) {
        if (err) return next(err);
        self._store(wallet, addresses, next);
      });
    });
  }, function (error) {
    self.storage.fetchWallet(wallet.id, function (err, wallet) {
      if (err) return cb(err);
      wallet.scanStatus = error ? 'error' : 'success';
      self.storage.storeWallet(wallet, function (err) {
        return cb(error || err);
      });
    })
  });
}

/**
 * Start a scan process.
 *
 * @param {Object} opts
 * @param {Boolean} opts.includeCopayerBranches [Optional] - (defaults to false)
 */
WalletService.prototype.startScan = function (opts, cb) {
  var self = this;

  function scanFinished(err) {
    var data = {
      result: err ? 'error' : 'success',
    };
    if (err) data.error = err;
    self._notify('ScanFinished', data, {
      isGlobal: true
    });
  };

  self.getWallet({}, function (err, wallet) {
    if (err) return cb(err);
    if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);

    setTimeout(function () {
      self.scan(opts, scanFinished);
    }, 100);

    return cb(null, {
      started: true
    });
  });
};

/**
 * Returns exchange rate for the specified currency & timestamp.
 * @param {Object} opts
 * @param {String} opts.code [Required] - Currency ISO code.
 * @param {Date} opts.ts [Optional] - A timestamp to base the rate on (default Date.now()).
 * @param {String} opts.provider [Optional] - A provider of exchange rates (default 'Bittrex').
 * @returns {Object} rates - The exchange rate.
 */
WalletService.prototype.getFiatRate = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['code'], cb)) return;

  self.fiatRateService.getRate(opts, function (err, rate) {
    if (err) return cb(err);
    return cb(null, rate);
  });
};

/**
 * Returns metadata for the specified asset.
 * @param {Object} opts
 * @param {String} opts.asset [Required] - Asset unit. 'all' for all assets.
 * @returns {Object} metadata - The asset metadata.
 */
WalletService.prototype.getAssets = function (opts, cb) {
  var self = this;

  if (!Utils.checkRequired(opts, ['asset'], cb)) return;

  if (opts.asset == 'all') {
    self.storage.fetchAssets({}, function (err, result) {
      if (err) return cb(err);
      return cb(null, result);
    })
  } else {
    self.storage.fetchAssetByUnit(opts.asset, function (err, result) {
      if (err) return cb(err);
      if (_.isEmpty(result)) return cb(new ClientError('No such asset'));
      return cb(null, result[0]);
    });
  }
};

/**
 * Subscribe this copayer to the Push Notifications service using the specified token.
 * @param {Object} opts
 * @param {String} opts.token [Required] - The token representing the app/device.
 * @param {String} opts.packageName [Optional] - The restricted_package_name option associated with this token.
 * @param {String} opts.platform [Optional] - The platform associated with this token.
 */
WalletService.prototype.pushNotificationsSubscribe = function (opts, cb) {
  if (!Utils.checkRequired(opts, ['token'], cb)) return;

  var self = this;

  var sub = Model.PushNotificationSub.create({
    copayerId: self.copayerId,
    token: opts.token,
    packageName: opts.packageName,
    platform: opts.platform,
  });

  self.storage.storePushNotificationSub(sub, cb);
};

/**
 * Unsubscribe this copayer to the Push Notifications service using the specified token.
 * @param {Object} opts
 * @param {String} opts.token [Required] - The token representing the app/device.
 */
WalletService.prototype.pushNotificationsUnsubscribe = function (opts, cb) {
  if (!Utils.checkRequired(opts, ['token'], cb)) return;

  var self = this;

  self.storage.removePushNotificationSub(self.copayerId, opts.token, cb);
};

/**
 * Subscribe this copayer to the specified tx to get a notification when the tx confirms.
 * @param {Object} opts
 * @param {String} opts.txid [Required] - The txid of the tx to be notified of.
 */
WalletService.prototype.txConfirmationSubscribe = function (opts, cb) {
  if (!Utils.checkRequired(opts, ['txid'], cb)) return;

  var self = this;

  var sub = Model.TxConfirmationSub.create({
    copayerId: self.copayerId,
    walletId: self.walletId,
    txid: opts.txid,
  });

  self.storage.storeTxConfirmationSub(sub, cb);
};

/**
 * Unsubscribe this copayer to the Push Notifications service using the specified token.
 * @param {Object} opts
 * @param {String} opts.txid [Required] - The txid of the tx to be notified of.
 */
WalletService.prototype.txConfirmationUnsubscribe = function (opts, cb) {
  if (!Utils.checkRequired(opts, ['txid'], cb)) return;

  var self = this;

  self.storage.removeTxConfirmationSub(self.copayerId, opts.txid, cb);
};

/**
 * Retrieves a wallet's pubic key from storage.
 * @param {Object} opts
 * @param {String} opts.address [Required] - The address associated with the wallet.
 * @returns {Object} walletId, pubKey
 */
WalletService.prototype.getWalletFromAddress = function (opts, cb) {
  var self = this;

  if (!opts.address) return cb(Errors.INVALID_ADDRESS);

  self.storage.fetchAddressByCoin(Defaults.COIN, opts.address, function (err, address) {
    if (err) return cb(err);
    if (address) {
      self.storage.fetchWallet(address.walletId, function (err, wallet) {
        if (err) return cb(err);
        if (wallet) return cb(null, {walletId: wallet.id, pubKey: wallet.pubKey});
        return cb(Errors.WALLET_NOT_FOUND);
      });
    } else {
      return cb(Errors.ADDRESS_NOT_FOUND);
    }
  });
};

/**
 * Create a message sent to other copayer
 * @param {Object} opts
 * @param {String} opts.data [Required] - The encrypted data sent to other copayer.
 * @param {String} opts.fromAddress [Optional] - The message sender's address. 
 * @param {String} opts.fromWalletId [Required] - The sender's wallet id. 
 * @param {String} opts.fromPubKey [Required] - The sender's public key.
 * @param {String} opts.toAddress [Optional] - The message receiver's address. 
 * @param {String} opts.toWalletId [Required] - The receiver's wallet id. 
 * @param {String} opts.toPubKey [Required] - The receiver's public key.
 * 
 * @returns {Object} Message
 */
WalletService.prototype.createMessage = function (opts, cb) {
  if (!Utils.checkRequired(opts, ['fromWalletId', 'fromPubKey', 'toWalletId', 'toPubKey', 'data'], cb)) return;

  var self = this;
      
  var walletId = opts.toWalletId;
  var copayerId = self.copayerId;
  $.checkState(walletId);

  var message = Model.Message.create(opts);
  self.storage.storeMessage(message, function (err) {
    if (err) return cb(err);
    var data = {
      fromWalletId: opts.fromWalletId,
      fromAddress: opts.fromAddress,
      toWalletId: opts.toWalletId,
      toAddress: opts.toAddress
    };

    var notification = Model.Notification.create({
      type: 'NewMessage',
      data: data,
      ticker: self.notifyTicker++,
      creatorId: copayerId,
      walletId: walletId,
    });

    self.storage.storeNotification(walletId, notification, function () {
      self.messageBroker.send(notification);
      return cb(null, message);
    });
  });
};

/**
 * Fetch messages
 * @param {Object} opts
 * @param {String} opts.direction [Required] - Indicate 'send' or 'receive' messages.
 * @param {String} opts.lastMessageId [Optional] - Get messages before this message id.
 * @param {String} opts.limit [Optional] - The size of the result set. 
 * 
 * @returns {Object} Message
 */
WalletService.prototype.getMessages = function (opts, cb) {
  var self = this;
console.log(opts)
  if (!_.includes(['send', 'receive'], opts.direction))
    return cb(new ClientError('unsupported message direction'));
  opts.limit = opts.limit || 10;

  var fromWalletId = null;
  var toWalletId = null;
  if (opts.direction == 'send') fromWalletId = self.walletId;
  if (opts.direction == 'receive') toWalletId = self.walletId;

  self.storage.fetchMessages(fromWalletId, toWalletId, opts, cb);
};

module.exports = WalletService;
module.exports.ClientError = ClientError;
