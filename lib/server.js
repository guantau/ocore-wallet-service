'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var async = require('async');
var log = require('npmlog');
var serverMessages = require('../serverMessages');

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
 * Check arguments needed
 * @param {Object} obj - object to be checked
 * @param {Array} args - arguments needed
 * @param {Callback} cb 
 */
function checkRequired(obj, args, cb) {
  var missing = Utils.getMissingFields(obj, args);
  if (_.isEmpty(missing)) {
    return true;
  }

  if (_.isFunction(cb)) {
    return cb(new ClientError('Required argument: ' + _.first(missing) + ' missing.'));
  }

  return false;
}

/**
 * Check if the asset is valid
 * @param {String} asset - asset unit
 * @param {Callback} cb [Optional]
 */
function checkAsset(asset, cb) {
  if (typeof asset === 'undefined' || asset === 'all' || asset === 'base' || asset === 'bytes') {
    return true;
  }

  if (ValidationUtils.isValidBase64(asset, OcoreConstants.HASH_LENGTH)) {
    return true;
  }

  if (_.isFunction(cb)) {
    return cb(new ClientError('Invalid asset.'));
  }

  return false;
}

/**
 * Gets the current version of OWS
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
 * @param {Storage} [opts.storage] - The storage provider.
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

WalletService.handleIncomingNotifications = function (notification, cb) {
  cb = cb || function () { };

  // do nothing here....
  return cb();
};

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
 * @param {string} opts.clientVersion - A string that identifies the client issuing the request
 */
WalletService.getInstance = function (opts) {
  opts = opts || {};

  var version = Utils.parseVersion(opts.clientVersion);
  // if (version && version.agent === 'owc') {
  //   if (version.major === 0 || (version.major === 1 && version.minor < 0)) {
  //     throw new ClientError(Errors.codes.UPGRADE_NEEDED, 'OWC clients < 1.0 are no longer supported.');
  //   }
  // }

  var server = new WalletService();
  server._setClientVersion(opts.clientVersion);
  server._setAppVersion(opts.userAgent);
  server.userAgent = opts.userAgent;
  return server;
};

/**
 * Gets an instance of the server after authenticating the copayer.
 * @param {Object} opts
 * @param {string} opts.copayerId - The copayer id making the request.
 * @param {string} opts.message - (Optional) The contents of the request to be signed. 
 *  Only needed if no session token is provided.
 * @param {string} opts.signature - (Optional) Signature of message to be verified using 
 * one of the copayer's requestPubKeys. 
 * Only needed if no session token is provided.
 * @param {string} opts.session - (Optional) A valid session token previously obtained using 
 * the #login method
 * @param {string} opts.clientVersion - A string that identifies the client issuing the request
 * @param {string} [opts.walletId] - The wallet id to use as current wallet 
 * for this request (only when copayer is support staff).
 */
WalletService.getInstanceWithAuth = function (opts, cb) {
  function withSignature(cb) {
    if (!checkRequired(opts, ['copayerId', 'message', 'signature'], cb)) {
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
    if (!checkRequired(opts, ['copayerId', 'session'], cb)) {
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
 * Get all copayers in deviceId
 * @param {Object} opts
 * @param {string} opts.deviceId - The device id.
 */
WalletService.prototype.getCopayers = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['deviceId'], cb)) {
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
 * @param {string} opts.id - The wallet id.
 * @param {string} opts.name - The wallet name.
 * @param {number} opts.m - Required copayers.
 * @param {number} opts.n - Total copayers.
 * @param {string} opts.pubKey - Public key to verify copayers joining have access to the wallet secret.
 * @param {string} opts.singleAddress[=true] - The wallet will only ever have one address.
 * @param {string} opts.coin[='obyte'] - The coin for this wallet.
 * @param {string} opts.network[='livenet'] - The network for this wallet.
 * @param {string} opts.supportBIP44[=true] - Client supports BIP44 for new wallets.
 */
WalletService.prototype.createWallet = function (opts, cb) {
  var self = this,
    pubKey;

  if (!checkRequired(opts, ['name', 'm', 'n', 'pubKey'], cb)) {
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
 * @param {string} opts.identifier - The identifier associated with the wallet (one of: walletId, address, txid).
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
      // sent txs
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
 * @param {Object} opts.includeExtendedInfo - Include PKR info & address managers for wallet & copayers
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

        status.serverMessage = serverMessages(wallet, self.appName, self.appVersion);
        next();
      });
    },

    function (next) {
      opts.wallet = status.wallet;
      self.getBalance(opts, function (err, balance) {
        // ignore WALLET_NEED_SCAN err is includeExtendedInfo is given
        // (to allow `importWallet` to import a wallet, while scan has
        // failed)
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
 * Verifies signature againt a collection of pubkeys
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
 * @param {Boolean} opts.isGlobal - If true, the notification is not issued on behalf of any particular copayer (defaults to false)
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
    ticker: this.notifyTicker++,
    creatorId: opts.isGlobal ? null : copayerId,
    walletId: walletId,
  });

  this.storage.storeNotification(walletId, notification, function () {
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
    asset: txp.asset,
    amount: txp.getTotalAmount(),
    message: txp.message,
  }, extraArgs);
  self._notify(type, data, {}, cb);
};

WalletService.prototype._addCopayerToWallet = function (wallet, opts, cb) {
  var self = this;

  var copayer = Model.Copayer.create({
    coin: wallet.coin,
    name: opts.name,
    deviceId: opts.deviceId,
    copayerIndex: wallet.copayers.length,
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
 * @param {string} opts.copayerId - The copayer id
 * @param {string} opts.requestPubKey - Public Key used to check requests from this copayer.
 * @param {string} opts.copayerSignature - S(requestPubKey). Used by other copayers to verify the that the copayer is himself (signed with REQUEST_KEY_AUTH)
 * @param {string} opts.restrictions
 *    - cannotProposeTXs
 *    - cannotXXX TODO
 * @param {string} opts.name  (name for the new access)
 */
WalletService.prototype.addAccess = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['copayerId', 'requestPubKey', 'signature'], cb)) return;

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
 * @param {string} opts.walletId - The wallet id.
 * @param {string} opts.deviceId - The device id.
 * @param {string} opts.coin[='obyte'] - The expected coin for this wallet.
 * @param {string} opts.name - The copayer name.
 * @param {string} opts.xPubKey - Extended Public Key for this copayer.
 * @param {string} opts.requestPubKey - Public Key used to check requests from this copayer.
 * @param {string} opts.copayerSignature - S(name|xPubKey|requestPubKey). Used by other copayers to verify that the copayer joining knows the wallet secret.
 * @param {string} opts.customData - (optional) Custom data for this copayer.
 * @param {string} opts.dryRun[=false] - (optional) Simulate the action but do not change server state.
 * @param {string} [opts.supportBIP44 = true] - Client supports BIP44 for joining wallets.
 */
WalletService.prototype.joinWallet = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['deviceId', 'walletId', 'name', 'xPubKey', 'requestPubKey', 'copayerSignature'], cb)) return;

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
 * Save copayer preferences for the current wallet/copayer pair.
 * @param {Object} opts
 * @param {string} opts.email - Email address for notifications.
 * @param {string} opts.language - Language used for notifications.
 * @param {string} opts.unit - Obyte unit used to format amounts in notifications.
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
    self.messageBroker.addAddress(address);
    return cb();
  });
};

/**
 * Creates a new address.
 * @param {Object} opts
 * @param {Boolean} [opts.ignoreMaxGap=false] - Ignore constraint of maximum number of consecutive addresses without activity
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
 * @param {Numeric} opts.limit (optional) - Limit the resultset. Return all addresses by default.
 * @param {Boolean} [opts.reverse=false] (optional) - Reverse the order of returned addresses.
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
 * @param {string} opts.message - The message to verify.
 * @param {string} opts.signature - The signature of message to verify.
 * @returns {truthy} The result of the verification.
 */
WalletService.prototype.verifyMessageSignature = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['message', 'signature'], cb)) return;

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
        for (const txp of txps) {
          for (const msg of txp.unit.messages) {
            if (msg.app == 'payment') {
              for (const input of msg.payload.inputs) {
                lockedInputs.push(utxoKey(input));
              }
            }
          }
        }

        _.each(lockedInputs, function (input) {
          if (utxoIndex[input]) {
            utxoIndex[input].locked = true;
          }
        });
        log.debug(`Got  ${lockedInputs.length} locked utxos`);
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

        for (const tx of txs) {
          for (const msg of tx.unit.messages) {
            if (msg.app == 'payment') {
              for (const input of msg.payload.inputs) {
                spentInputs.push(utxoKey(input));
              }
            }
          }
        }

        _.each(spentInputs, function (input) {
          if (utxoIndex[input]) {
            utxoIndex[input].spent = true;
          }
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
 * @param {Array} [opts.addresses] - List of addresses. options. only one address is supported
 * @param {String} [opts.asset] - Asset. options. 'null' for all, 'base' for bytes
 * @returns {Array} utxos - List of UTXOs.
 */
WalletService.prototype.getUtxos = function (opts, cb) {
  var self = this;

  opts = opts || {};

  if (opts.coin) {
    return cb(new ClientError('coins option no longer supported'));
  }

  if (!checkAsset(opts.asset, cb)) {
    return;
  }

  if (opts.addresses) {
    blockchainExplorer.getUtxos(opts.addresses, opts.asset, (err, utxos) => {
      if (err) return cb(err);
      return cb(null, utxos);
    });
  } else {
    self._getUtxosForCurrentWallet({}, cb);
  }
};

/**
 * Get wallet balance.
 * @param {Object} opts
 * @param {Array} [opts.addresses] - List of addresses. options. null for all addresses in wallet
 * @param {String} [opts.asset] - Asset. options. 'null' and 'all' for all assets, 'base' and 'bytes' for bytes
 * @returns {Object} balance - Total amount & pending amount.
 */
WalletService.prototype.getBalance = function (opts, cb) {
  var self = this;
  opts = opts || {};

  if (!checkAsset(opts.asset, cb)) {
    return;
  }

  if (opts.addresses) {
    blockchainExplorer.getBalance(opt.addresses, opts.asset, function (err, balance) {
      if (err) return cb(err);
      return cb(null, balance);
    });
  } else {
    self.getWallet({}, function(err, wallet){
      if (err) return cb(err);

      if (wallet.scanStatus == 'error') 
        return cb(Errors.WALLET_NEED_SCAN);

      self.storage.fetchAddresses(self.walletId, function (err, addresses) {
        if (err) return cb(err);
        if (_.isEmpty(addresses)) return cb(null, {total: { base: { stable: 0, pending: 0, stable_outputs_count: 0, pending_outputs_count: 0 } }});
        var addressesStr = _.map(addresses, 'address');
        blockchainExplorer.getBalance(addressesStr, opts.asset, function (err, balances) {
          if (err) return cb(err);
          return cb(null, balances);
        });
      });
    });
  }
};

WalletService.prototype._getSigner = function () {
  var self = this;

	return {
		readSigningPaths: function (address, handleLengthsBySigningPaths) { 
      self.storage.fetchAddressByWalletId(self.walletId, address, function (err, result) {
        if (err) handleLengthsBySigningPaths(err);
        if (!result) handleLengthsBySigningPaths(Errors.ADDRESS_NOT_FOUND);
				var assocLengthsBySigningPaths = {};
        for (var i in result.signingPath) {
          var signing_path = result.signingPath[i];
          assocLengthsBySigningPaths[signing_path] = OcoreConstants.SIG_LENGTH;
        }
        var addressInfo = _.pick(result, ['walletId', 'path']);
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

    if (!checkRequired(output, ['address', 'amount'])) {
      return new ClientError('Argument missing in output #' + (i + 1) + '.');
    }

    if (!_.isNumber(output.amount) || _.isNaN(output.amount) || output.amount <= 0) {
      return new ClientError('Invalid amount');
    }

    opts.outputs[i] = _.pick(output, 'address', 'amount')
  }
  return null;
};

WalletService.prototype._validateAndSanitizeTxOpts = function (wallet, opts, cb) {
  var self = this;

  async.series([
    function (next) {
      if (wallet.singleAddress && opts.changeAddress) return next(new ClientError('Cannot specify change address on single-address wallet'));
      next();
    },
    function (next) {
      var validationError = self._validateOutputs(opts, wallet, next);
      if (validationError) {
        return next(validationError);
      }
      next();
    }
  ], cb);
};

/**
 * Creates a new transaction proposal.
 * @param {Object} opts
 * @param {string} opts.txProposalId - Optional. If provided it will be used as this TX proposal ID. Should be unique in the scope of the wallet.
 * @param {String} opts.asset - Asset name. default 'base'.
 * @param {Array} opts.outputs - List of outputs.
 * @param {string} opts.outputs[].address - Destination address.
 * @param {number} opts.outputs[].amount - Amount to transfer in satoshi.
 * @param {string} opts.message - A message to attach to this transaction.
 * @param {string} opts.changeAddress - Optional. Use this address as the change address for the tx. The address should belong to the wallet. In the case of singleAddress wallets, the first main address will be used.
 * @param {Boolean} opts.sendAll - Optional. Send maximum amount of funds.
 * @param {Boolean} opts.spendUnconfirmed[=false] - Optional. Do not use UTXOs of unconfirmed transactions as inputs
 * @param {Array} opts.inputs - Optional. Inputs for this TX
 * @returns {TxProposal} Unsigned joint.
 */
WalletService.prototype.createTx = function (opts, cb) {
  var self = this;

  opts = opts || {};

  if (!checkAsset(opts.asset, cb)) {
    return;
  }

  var asset = null;
  if (opts.asset && opts.asset.length == OcoreConstants.HASH_LENGTH) {
    asset = opts.asset;
  }

  function getChangeAddress(wallet, cb) {
    if (wallet.singleAddress) {
      self.storage.fetchAddresses(self.walletId, function (err, addresses) {
        if (err) return cb(err);
        if (_.isEmpty(addresses)) return cb(new ClientError('The wallet has no addresses'));
        return cb(null, _.head(addresses));
      });
    } else {
      if (opts.changeAddress) {
        if (!ValidationUtils.isValidAddress(opts.changeAddress)) return cb(addrErr);

        self.storage.fetchAddressByWalletId(wallet.id, opts.changeAddress, function (err, address) {
          if (err || !address) return cb(Errors.INVALID_CHANGE_ADDRESS);
          return cb(null, address);
        });
      } else {
        // TODO: choose non-active change address or create new
        return cb(null, wallet.createAddress(true), true);
      }
    }
  };

  function checkTxpAlreadyExists(txProposalId, cb) {
    if (!txProposalId) return cb();
    self.storage.fetchTx(self.walletId, txProposalId, cb);
  };

  self._runLocked(cb, function (cb) {
    var txp, changeAddress;
    self.getWallet({}, function (err, wallet) {
      if (err) return cb(err);
      if (!wallet.isComplete()) return cb(Errors.WALLET_NOT_COMPLETE);

      if (wallet.scanStatus == 'error')
        return cb(Errors.WALLET_NEED_SCAN);

      checkTxpAlreadyExists(opts.txProposalId, function (err, tx) {
        if (err) return cb(err);
        if (tx) return cb(null, tx);

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
            if (opts.sendAll) return next();
            getChangeAddress(wallet, function (err, address, isNew) {
              if (err) return next(err);
              changeAddress = address;
              return next();
            });
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
                asset: asset,
                changeAddress: changeAddress,
                walletM: wallet.m,
                walletN: wallet.n,
                spendUnconfirmed: opts.spendUnconfirmed,
                addressType: wallet.addressType,
                customData: opts.customData,
                unit: opts.unit,
                signingInfo: opts.signingInfo
              };
              txp = Model.TxProposal.create(txOpts);
              return next();
            }

            self.storage.fetchAddresses(self.walletId, function (err, addresses) {
              if (err) return next(err);
              if (_.isEmpty(addresses)) return next(Errors.ADDRESS_NOT_FOUND);
              var addressesStr = _.map(addresses, 'address');

              var params = {
                asset: asset,
                available_paying_addresses: addressesStr,
                messages: opts.messages,
                spend_unconfirmed: opts.spendUnconfirmed || 'own',
                signer: self._getSigner(),
                callbacks: {
                  ifNotEnoughFunds: function(err) {
                    next(err);
                  },
                  ifError: function(err) {
                    next(err);
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
                      asset: asset,
                      changeAddress: changeAddress,
                      walletM: wallet.m,
                      walletN: wallet.n,
                      spendUnconfirmed: opts.spendUnconfirmed,
                      addressType: wallet.addressType,
                      customData: opts.customData,
                      unit: objJoint.unit,
                      signingInfo: objJoint.signingInfo
                    };
                    txp = Model.TxProposal.create(txOpts);
                    next();
                  }
                }
              };

              if (asset) {
                if (opts.sendAll) return next('send all with asset');
                params.asset = asset;
                params.available_fee_paying_addresses = addressesStr;
                params.asset_outputs = opts.outputs;
                params.change_address = changeAddress.address;
                OcoreStorage.readAsset(OcoreDb, asset, null, function(err, objAsset){
                  if (err) return next(err);
                  if (objAsset.is_private) return next('private asset is not supported');

                  if (objAsset.fixed_denominations) { // indivisible
                    params.tolerance_plus = 0;
                    params.tolerance_minus = 0;
                    IndivisibleAsset.composeMinimalIndivisibleAssetPaymentJoint(params);
                  } else{ // divisible
                    DivisibleAsset.composeMinimalDivisibleAssetPaymentJoint(params);
                  }
                });
              }
              else{ // base asset
                params.outputs = opts.outputs;
                if (opts.sendAll){
                  params.send_all = opts.sendAll;
                } else {
                  params.outputs.push({address: changeAddress.address, amount: 0});
                }
                Composer.composeMinimalJoint(params);
              }
            });
          },

          function (next) {
            if (!changeAddress || wallet.singleAddress || opts.dryRun) return next();
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
 * @param {string} opts.txProposalId - The tx id.
 * @param {string} opts.proposalSignature - S(raw tx). Used by other copayers to verify the proposal.
 */
WalletService.prototype.publishTx = function (opts, cb) {
  var self = this;

  function utxoKey(utxo) {
    return utxo.unit + '|' + utxo.message_index + '|' + utxo.output_index;
  };

  if (!checkRequired(opts, ['txProposalId', 'proposalSignature'], cb)) return;
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
 * @param {string} opts.txProposalId - The tx id.
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
 * Edit note associated to a txid.
 * @param {Object} opts
 * @param {string} opts.txid - The txid of the tx on the blockchain.
 * @param {string} opts.body - The contents of the note.
 */
WalletService.prototype.editTxNote = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, 'txid', cb)) return;

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
 * @param {string} opts.txid - The txid associated with the note.
 */
WalletService.prototype.getTxNote = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, 'txid', cb)) return;
  self.storage.fetchTxNote(self.walletId, opts.txid, cb);
};

/**
 * Get tx notes.
 * @param {Object} opts
 * @param {string} opts.minTs[=0] - The start date used to filter notes.
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
 * @param {string} opts.txProposalId - The tx id.
 * @return {undefined}
 */
WalletService.prototype.removePendingTx = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['txProposalId'], cb)) return;

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
 * @param {string} [opts.coin = 'obyte'] - The coin for this transaction.
 * @param {string} [opts.network = 'livenet'] - The network for this transaction.
 * @param {string} opts.joint - Raw joint data.
 */
WalletService.prototype.broadcastJoint = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['joint'], cb)) return;

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
 * @param {string} opts.txProposalId - The identifier of the transaction.
 * @param {string} opts.signatures - The signatures of the inputs of this tx for this copayer (in apperance order)
 */
WalletService.prototype.signTx = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['txProposalId', 'signatures'], cb)) return;

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

    return cb(null, txp);
  });
};

/**
 * Broadcast a transaction proposal.
 * @param {Object} opts
 * @param {string} opts.txProposalId - The identifier of the transaction.
 */
WalletService.prototype.broadcastTx = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['txProposalId'], cb)) return;

  self.getWallet({}, function (err, wallet) {
    if (err) return cb(err);

    self.getTx({
      txProposalId: opts.txProposalId
    }, function (err, txp) {
      if (err) return cb(err);

      if (txp.status == 'broadcasted') return cb(Errors.TX_ALREADY_BROADCASTED);
      if (txp.status != 'accepted') return cb(Errors.TX_NOT_ACCEPTED);

      var objJoint = _.pick(txp, ['unit', 'timestamp']);

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
 * @param {string} opts.txProposalId - The identifier of the transaction.
 * @param {string} [opts.reason] - A message to other copayers explaining the rejection.
 */
WalletService.prototype.rejectTx = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['txProposalId'], cb)) return;

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
 * Retrieves all transaction proposals in the range (maxTs-minTs)
 * Times are in UNIX EPOCH
 *
 * @param {Object} opts.minTs (defaults to 0)
 * @param {Object} opts.maxTs (defaults to now)
 * @param {Object} opts.limit
 * @returns {TxProposal[]} Transaction proposals, newer first
 */
WalletService.prototype.getTxs = function (opts, cb) {
  var self = this;
  self.storage.fetchTxs(self.walletId, opts, function (err, txps) {
    if (err) return cb(err);
    return cb(null, txps);
  });
};

/**
 * Retrieves notifications after a specific id or from a given ts (whichever is more recent).
 *
 * @param {Object} opts
 * @param {Object} opts.notificationId (optional)
 * @param {Object} opts.minTs (optional) - default 0.
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
 * @param {String} opts.asset - asset unit
 * @param {Number} opts.skip (defaults to 0)
 * @param {Number} opts.limit
 * @param {Number} opts.includeExtendedInfo[=false] - Include all inputs/outputs for every tx.
 * @returns {TxProposal[]} Transaction proposals, first newer
 */
WalletService.prototype.getTxHistory = function (opts, cb) {
  var self = this;
  opts = opts || {};

  opts.skip = (_.isUndefined(opts.skip) ? 0 : opts.skip);
  opts.limit = (_.isUndefined(opts.limit) ? 50 : opts.limit);
  if (opts.limit > Defaults.HISTORY_LIMIT)
    return cb(Errors.HISTORY_LIMIT_EXCEEDED);

  if (!checkAsset(opts.asset, cb)) {
    return;
  }

  var asset = null;
  if (opts.asset && opts.asset.length == OcoreConstants.HASH_LENGTH) {
    asset = opts.asset;
  }

  async.waterfall([

    function (next) {
      if (opts.addresses) {
        blockchainExplorer.getTxHistory(opts.addresses, asset, opts, function (err, txs) {
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
            blockchainExplorer.getTxHistory(addressesStr, asset, opts, function (err, txs) {
              if (err) return next(err);
              return next(null, txs);
            });
          });
        });
      }
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
 * @param {Boolean} opts.includeCopayerBranches (defaults to false)
 * @param {Boolean} opts.startingStep (estimate address number magniture (default to 1k), only
 * for optimization)
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
        console.log('[server.js.2999:address:] SCANING:' + address.address+ ':'+address.path + " :" + !!activity); //TODO
        
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

      self._store(wallet, addresses, next);
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
 * @param {Boolean} opts.includeCopayerBranches (defaults to false)
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
 * @param {string} opts.code - Currency ISO code.
 * @param {Date} [opts.ts] - A timestamp to base the rate on (default Date.now()).
 * @param {String} [opts.provider] - A provider of exchange rates (default 'Bittrex').
 * @returns {Object} rates - The exchange rate.
 */
WalletService.prototype.getFiatRate = function (opts, cb) {
  var self = this;

  if (!checkRequired(opts, ['code'], cb)) return;

  self.fiatRateService.getRate(opts, function (err, rate) {
    if (err) return cb(err);
    return cb(null, rate);
  });
};

/**
 * Subscribe this copayer to the Push Notifications service using the specified token.
 * @param {Object} opts
 * @param {string} opts.token - The token representing the app/device.
 * @param {string} [opts.packageName] - The restricted_package_name option associated with this token.
 * @param {string} [opts.platform] - The platform associated with this token.
 */
WalletService.prototype.pushNotificationsSubscribe = function (opts, cb) {
  if (!checkRequired(opts, ['token'], cb)) return;

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
 * @param {string} opts.token - The token representing the app/device.
 */
WalletService.prototype.pushNotificationsUnsubscribe = function (opts, cb) {
  if (!checkRequired(opts, ['token'], cb)) return;

  var self = this;

  self.storage.removePushNotificationSub(self.copayerId, opts.token, cb);
};

/**
 * Subscribe this copayer to the specified tx to get a notification when the tx confirms.
 * @param {Object} opts
 * @param {string} opts.txid - The txid of the tx to be notified of.
 */
WalletService.prototype.txConfirmationSubscribe = function (opts, cb) {
  if (!checkRequired(opts, ['txid'], cb)) return;

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
 * @param {string} opts.txid - The txid of the tx to be notified of.
 */
WalletService.prototype.txConfirmationUnsubscribe = function (opts, cb) {
  if (!checkRequired(opts, ['txid'], cb)) return;

  var self = this;

  self.storage.removeTxConfirmationSub(self.copayerId, opts.txid, cb);
};

module.exports = WalletService;
module.exports.ClientError = ClientError;
