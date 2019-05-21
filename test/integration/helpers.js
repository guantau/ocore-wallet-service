// "use strict";

var _ = require("lodash");
var async = require("async");

var chai = require("chai");
var sinon = require("sinon");
var should = chai.should();
var log = require("npmlog");
log.debug = log.verbose;

var config = require("../test-config");

var Bitcore = require("bitcore-lib");
var ObjectHash = require("ocore/object_hash");
var ObjectLength = require("ocore/object_length");
var Signature = require("ocore/signature");
var crypto = require("crypto");

var Obyte = require('obyte');

var Common = require("../../lib/common");
var Utils = Common.Utils;
var Constants = Common.Constants;
var Defaults = Common.Defaults;

var Storage = require("../../lib/storage");
var Model = require("../../lib/model");
var WalletService = require("../../lib/server");
var TestData = require("../testdata");

var storage, blockchainExplorer;

var helpers = {};

helpers.CLIENT_VERSION = "owc-2.0.0";

helpers.before = function(cb) {
  function getDb(cb) {
    var mongodb = require("mongodb");
    mongodb.MongoClient.connect(config.mongoDb.uri, function(err, db) {
      if (err) throw err;
      return cb(db);
    });
  }

  function getLightProps (cb) {
    const client = new Obyte.Client();
    client.api.getWitnesses(function(err, witnesses) {
      if (err) throw err;
      helpers._witnesses = witnesses;
      const params = {
        witnesses: witnesses
      };
      
      client.api.getParentsAndLastBallAndWitnessListUnit(params, function(err, result) {
        if (err) throw err;
        helpers._lightProps = result;
        return cb();
      });
    });
  }

  getDb(function(db) {
    storage = new Storage({
      db: db
    });
//    getLightProps(cb);
    return cb();
  });
};

helpers.beforeEach = function(cb) {
  if (!storage.db) return cb();
  storage.db.dropDatabase(function(err) {
    if (err) return cb(err);
    let be = blockchainExplorer = sinon.stub();

    var opts = {
      storage: storage,
      blockchainExplorer: blockchainExplorer,
      request: sinon.stub()
    };

    WalletService.initialize(opts, function() {
      return cb(opts);
    });
  });
};

helpers.after = function(cb) {
  WalletService.shutDown(() => {
    setImmediate(cb);
  });
};

helpers.getBlockchainExplorer = function() {
  return blockchainExplorer;
};

helpers.getStorage = function() {
  return storage;
};

helpers.signMessage = function(text, privKey) {
  var priv = new Bitcore.PrivateKey(privKey);
  var hash = Utils.hashMessage(text);
  return Bitcore.crypto.ECDSA.sign(hash, priv, "little").toString();
};

helpers.signRequestPubKey = function(requestPubKey, xPrivKey) {
  var priv = new Bitcore.HDPrivateKey(xPrivKey).deriveChild(
    Constants.PATHS.REQUEST_KEY_AUTH
  ).privateKey;
  return helpers.signMessage(requestPubKey, priv);
};

helpers.getAuthServer = function(copayerId, cb) {
  var verifyStub = sinon.stub(WalletService.prototype, "_verifySignature");
  verifyStub.returns(true);

  WalletService.getInstanceWithAuth(
    {
      copayerId: copayerId,
      message: "dummy",
      signature: "dummy",
      clientVersion: helpers.CLIENT_VERSION
    },
    function(err, server) {
      verifyStub.restore();
      if (err || !server)
        throw new Error(
          "Could not login as copayerId " + copayerId + " err: " + err
        );
      return cb(server);
    }
  );
};

helpers._generateCopayersTestData = function() {
  var xPrivKeys = [
    "xprv9s21ZrQH143K2n4rV4AtAJFptEmd1tNMKCcSyQBCSuN5eq1dCUhcv6KQJS49joRxu8NNdFxy8yuwTtzCPNYUZvVGC7EPRm2st2cvE7oyTbB",
    "xprv9s21ZrQH143K3BwkLceWNLUsgES15JoZuv8BZfnmDRcCGtDooUAPhY8KovhCWcRLXUun5AYL5vVtUNRrmPEibtfk9ongxAGLXZzEHifpvwZ",
    "xprv9s21ZrQH143K3xgLzxd6SuWqG5Zp1iUmyGgSsJVhdQNeTzAqBFvXXLZqZzFZqocTx4HD9vUVYU27At5i8q46LmBXXL97fo4H9C3tHm4BnjY",
    "xprv9s21ZrQH143K48nfuK14gKJtML7eQzV2dAH1RaqAMj8v2zs79uaavA9UTWMxpBdgbMH2mhJLeKGq8AFA6GDnFyWP4rLmknqZAfgFFV718vo",
    "xprv9s21ZrQH143K44Bb9G3EVNmLfAUKjTBAA2YtKxF4zc8SLV1o15JBoddhGHE9PGLXePMbEsSjCCvTvP3fUv6yMXZrnHigBboRBn2DmNoJkJg",
    "xprv9s21ZrQH143K48PpVxrh71KdViTFhAaiDSVtNFkmbWNYjwwwPbTrcqoVXsgBfue3Gq9b71hQeEbk67JgtTBcpYgKLF8pTwVnGz56f1BaCYt",
    "xprv9s21ZrQH143K3pgRcRBRnmcxNkNNLmJrpneMkEXY6o5TWBuJLMfdRpAWdb2cG3yxbL4DxfpUnQpjfQUmwPdVrRGoDJmtAf5u8cyqKCoDV97",
    "xprv9s21ZrQH143K3nvcmdjDDDZbDJHpfWZCUiunwraZdcamYcafHvUnZfV51fivH9FPyfo12NyKH5JDxGLsQePyWKtTiJx3pkEaiwxsMLkVapp",
    "xprv9s21ZrQH143K2uYgqtYtphEQkFAgiWSqahFUWjgCdKykJagiNDz6Lf7xRVQdtZ7MvkhX9V3pEcK3xTAWZ6Y6ecJqrXnCpzrH9GSHn8wyrT5",
    "xprv9s21ZrQH143K2wcRMP75tAEL5JnUx4xU2AbUBQzVVUDP7DHZJkjF3kaRE7tcnPLLLL9PGjYTWTJmCQPaQ4GGzgWEUFJ6snwJG9YnQHBFRNR"
  ];

  console.log("var copayers = [");
  _.each(xPrivKeys, function(xPrivKeyStr, c) {
    var xpriv = Bitcore.HDPrivateKey(xPrivKeyStr);
    var xpub = Bitcore.HDPublicKey(xpriv);

    var xpriv_45H = xpriv.deriveChild(45, true);
    var xpub_45H = Bitcore.HDPublicKey(xpriv_45H);
    var id45 = Model.Copayer._xPubToCopayerId("obyte", xpub_45H.toString());

    var xpriv_44H_0H_0H = xpriv.deriveChild(44, true).deriveChild(0, true).deriveChild(0, true);
    var xpub_44H_0H_0H = Bitcore.HDPublicKey(xpriv_44H_0H_0H);
    var id44 = Model.Copayer._xPubToCopayerId("obyte", xpub_44H_0H_0H.toString());

    var xpriv_1H = xpriv.deriveChild(1, true);
    var xpub_1H = Bitcore.HDPublicKey(xpriv_1H);
    var priv = xpriv_1H.deriveChild(0).privateKey;
    var pub = xpub_1H.deriveChild(0).publicKey;

    console.log("id44: ", "'" + id44 + "',");
    console.log("id45: ", "'" + id45 + "',");
    console.log("xPrivKey: ", "'" + xpriv.toString() + "',");
    console.log("xPubKey: ", "'" + xpub.toString() + "',");
    console.log("xPrivKey_45H: ", "'" + xpriv_45H.toString() + "',");
    console.log("xPubKey_45H: ", "'" + xpub_45H.toString() + "',");
    console.log("xPrivKey_44H_0H_0H: ", "'" + xpriv_44H_0H_0H.toString() + "',");
    console.log("xPubKey_44H_0H_0H: ", "'" + xpub_44H_0H_0H.toString() + "',");
    console.log("xPrivKey_1H: ", "'" + xpriv_1H.toString() + "',");
    console.log("xPubKey_1H: ", "'" + xpub_1H.toString() + "',");
    console.log("privKey_1H_0: ", "'" + priv.toString() + "',");
    console.log("pubKey_1H_0: ", "'" + pub.toString() + "'},");
  });
  console.log("];");
};

helpers.getSignedCopayerOpts = function(opts) {
  var hash = WalletService._getCopayerHash(
    opts.name,
    opts.xPubKey,
    opts.requestPubKey
  );
  opts.copayerSignature = helpers.signMessage(hash, TestData.keyPair.priv);
  opts.deviceId = '0' + ObjectHash.getChash160(opts.devicePubKey.toBuffer().toString('base64'));
  return opts;
};

helpers.createAndJoinWallet = function(m, n, opts, cb) {
  if (_.isFunction(opts)) {
    cb = opts;
    opts = {};
  }
  opts = opts || {};

  var server = new WalletService();
  var copayerIds = [];
  var offset = opts.offset || 0;

  var walletOpts = {
    name: "a wallet",
    m: m,
    n: n,
    pubKey: TestData.keyPair.pub,
    coin: opts.coin || "obyte",
    network: opts.network || "livenet",
    singleAddress: opts.singleAddress || false
  };
  if (_.isBoolean(opts.supportBIP44))
    walletOpts.supportBIP44 = opts.supportBIP44;

  server.createWallet(walletOpts, function(err, walletId) {
    if (err) return cb(err);

    async.eachSeries(
      _.range(n),
      function(i, cb) {
        var copayerData = TestData.copayers[i + offset];

        var pub =
          _.isBoolean(opts.supportBIP44) && !opts.supportBIP44
            ? copayerData.xPubKey_45H
            : copayerData.xPubKey_44H_0H_0H;

        var dxpri = Bitcore.HDPrivateKey(copayerData.xPrivKey_1H);

        if (opts.network == "testnet") return cb("testnet is not supported");

        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          coin: opts.coin,
          name: "copayer " + (i + 1),
          xPubKey: pub,
          requestPubKey: copayerData.pubKey_1H_0,
          customData: "custom data " + (i + 1),
          devicePubKey: dxpri.privateKey.toPublicKey()
        });
        if (_.isBoolean(opts.supportBIP44))
          copayerOpts.supportBIP44 = opts.supportBIP44;

        server.joinWallet(copayerOpts, function(err, result) {
          if (err) console.log(err);
          should.not.exist(err);
          copayerIds.push(result.copayerId);
          return cb(err);
        });
      },
      function(err) {
        if (err) return new Error("Could not generate wallet");
        helpers.getAuthServer(copayerIds[0], function(s) {
          if (opts.earlyRet) return cb(s);
          s.getWallet({}, function(err, w) {
            cb(s, w);
          });
        });
      }
    );
  });
};

helpers.randomTXID = function() {
  return crypto.createHash("sha256").update(Math.random().toString(), "utf8").digest("base64");
};

helpers._parseAmount = function(str) {
  var amount = +0;

  if (_.isNumber(str)) str = str.toString();

  var re = /^([\d\.]+)\s*(bytes|KB|MB|GB)?$/;
  var match = str.match(re);

  if (!match) throw new Error("Could not parse amount " + str);

  switch (match[2]) {
    default:
    case "GB":
      amount = Utils.strip(+match[1] * 1e9);
      break;
    case "MB":
      amount = Utils.strip(+match[1] * 1e6);
      break;
    case "KB":
      amount = Utils.strip(+match[1] * 1e3);
      break;
    case "bytes":
      amount = Utils.strip(+match[1]);
      break;
  }

  return amount;
};

helpers.stubUtxos = function(server, wallet, amounts, opts, cb) {
  if (_.isFunction(opts)) {
    cb = opts;
    opts = {};
  }
  opts = opts || {};

  if (!helpers._utxos) helpers._utxos = {};

  async.waterfall(
    [
      function(next) {
        if (opts.addresses) return next(null, [].concat(opts.addresses));
        async.mapSeries(
          _.range(0, amounts.length > 2 ? 2 : 1),
          function(i, next) {
            server.createAddress({}, next);
          },
          next
        );
      },
      function(addresses, next) {
        addresses.should.not.be.empty;

        var utxos = _.compact(
          _.map([].concat(amounts), function(amount, i) {
            var amount = helpers._parseAmount(amount);
            if (amount <= 0) return null;

            var address = addresses[i % addresses.length];

            return {
              unit: helpers.randomTXID(),
              message_index: _.random(0, 10),
              output_index: _.random(0, 10),
              asset: null,
              amount: amount,
              is_stable: true,
              address: address.address,
              path: address.path,
              definition: address.definition,
              signingPath: address.signingPath,
              walletId: wallet.id,
              is_spent: false,
            };
          })
        );

        if (opts.keepUtxos) {
          helpers._utxos = helpers._utxos.concat(utxos);
        } else {
          helpers._utxos = utxos;
        }

        blockchainExplorer.getUtxos = function(addresses, asset, cb) {
          var selected = [];
          helpers._utxos.forEach(function(utxo) {
            if (addresses.includes(utxo.address)) {
              selected.push(utxo);
            }
          });
          return cb(null, selected);
        };

        blockchainExplorer.getBalance = function(addresses, asset, cb) {
          var balances = {};
          balances['total'] = { base: { stable: 0, pending: 0, stable_outputs_count: 0, pending_outputs_count: 0 } };
          addresses.forEach(function (address) {
            balances[address] = { base: { stable: 0, pending: 0, stable_outputs_count: 0, pending_outputs_count: 0 } };
          });

          helpers._utxos.forEach(function(utxo) {
            if (addresses.includes(utxo.address) && !utxo.is_spent) {
              balances[utxo.address][utxo.asset || 'base'][utxo.is_stable ? 'stable' : 'pending'] += utxo.amount;
              balances[utxo.address][utxo.asset || 'base'][utxo.is_stable ? 'stable_outputs_count' : 'pending_outputs_count'] = 1;
    
              balances['total'][utxo.asset || 'base'][utxo.is_stable ? 'stable' : 'pending'] += utxo.amount;
              balances['total'][utxo.asset || 'base'][utxo.is_stable ? 'stable_outputs_count' : 'pending_outputs_count'] += 1;
            }
          });

          return cb(null, balances);
        };

        return next();
      }
    ],
    function(err) {
      should.not.exist(err);
      return cb(helpers._utxos);
    }
  );
};

helpers.stubBroadcast = function() {
  blockchainExplorer.broadcastJoint = sinon.stub().callsArgWith(1, null, null);
  blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, null);
};

helpers.stubHistory = function(txs) {
  blockchainExplorer.getTxHistory = function(addresses, asset, opts, cb) {
    return cb(null, txs);
  };
};

var stubAddressActivityFailsOn = null;
var stubAddressActivityFailsOnCount = 1;
helpers.stubAddressActivity = function(activeAddresses, failsOn) {
  stubAddressActivityFailsOnCount = 1;
  
  // could be null
  stubAddressActivityFailsOn = failsOn;

  blockchainExplorer.getAddressActivity = function(address, cb) {
    if (stubAddressActivityFailsOnCount === stubAddressActivityFailsOn)
      return cb('failed on request');
    
    stubAddressActivityFailsOnCount++;
    return cb(null, _.includes(activeAddresses, address));
  };
};

helpers.clientSign = function(txp, xpriv, walletId) {
  var xPrivKey = Bitcore.HDPrivateKey(xpriv);
  var objUnit = txp.unit;
  var assocSigningInfo = txp.signingInfo;
  var signatures = {};
  var text_to_sign = ObjectHash.getUnitHashToSign(objUnit);
  for (const author of objUnit.authors) {
    var address = author.address;
    if (walletId == assocSigningInfo[address].walletId) {
      for (const path of assocSigningInfo[address].signingPaths) {
        var privateKey = xPrivKey.derive(assocSigningInfo[address].path).privateKey;
        var privKeyBuf = privateKey.bn.toBuffer({ size: 32 });
        author.authentifiers[path] = Signature.sign(text_to_sign, privKeyBuf);
      }
      signatures[address] = author.authentifiers; 
    }
  }
  return signatures;
};

helpers.getProposalSignatureOpts = function(txp, signingKey) {
  var objUnit = txp.unit;
  var hash = ObjectHash.getUnitHashToSign(objUnit);
  var proposalSignature = helpers.signMessage(hash, signingKey);

  return {
    txProposalId: txp.id,
    proposalSignature: proposalSignature,
    testRun: true,
  };
};

helpers.createAddresses = function(server, wallet, main, change, cb) {
  // var clock = sinon.useFakeTimers('Date');
  async.mapSeries(
    _.range(main + change),
    function(i, next) {
      // clock.tick(1000);
      var address = wallet.createAddress(i >= main);
      server.storage.storeAddressAndWallet(wallet, address, function(err) {
        next(err, address);
      });
    },
    function(err, addresses) {
      should.not.exist(err);
      // clock.restore();

      return cb(_.take(addresses, main), _.takeRight(addresses, change));
    }
  );
};

helpers.createAndPublishTx = function(server, txOpts, xpriv, cb) {
  txOpts = helpers.composeJoint(txOpts);

  server.createTx(txOpts, function(err, txp) {
    if (err) console.log(err);
    should.not.exist(err, "Error creating a TX");
    should.exist(txp, "Error... no txp");
    var publishOpts = helpers.getProposalSignatureOpts(txp, xpriv);
    server.publishTx(publishOpts, function(err) {
      if (err) console.log(err);
      should.not.exist(err);
      return cb(txp);
    });
  });
};

const lightProps = {
  parent_units: ['sJJWrBAwmecNQhIfl6wxf/J4h0/N7hxkon5TV/pFHBg='],
  last_stable_mc_ball: 'q/wze2Pn6uqKHjOtf4JSzc0zRkZAQVIIBVFSoQ6qRWQ=',
  last_stable_mc_ball_unit: 'BGHDWQ1kJwRRhkTRWpfTITbqdTSdfzjEdkLDKdZjqlg=',
  last_stable_mc_ball_mci: 4129364,
  witness_list_unit: 'J8QFgTLI+3EkuAxX+eL6a0q114PJ4h4EOAiHAzxUp24='
};

const hash_placeholder = "--------------------------------------------"; // 256 bits (32 bytes) base64: 44 bytes
const sig_placeholder = "----------------------------------------------------------------------------------------"; // 88 bytes

helpers.composeJoint = function (txOpts) {
  var opts = {
    app: 'payment',
    params: txOpts
  }

  helpers._utxos.should.not.be.empty;

  var utxo = helpers._utxos.find(function(item) {
    return !item.is_spent;
  });
  utxo.is_spent = true;

  var objPaymentMessage = {
    app: "payment",
    payload_location: "inline",
    payload_hash: hash_placeholder,
    payload: {
      inputs: [{
        unit: utxo.unit,
        message_index: utxo.message_index,
        output_index: utxo.output_index
      }],
      outputs: txOpts.outputs
    }
  };
  objPaymentMessage.payload_hash = ObjectHash.getBase64Hash(objPaymentMessage.payload);

  var arrMessages = [];
  arrMessages.push(objPaymentMessage);

  var objUnit = {
    version: '1.0',
    alt: '1',
    witness_list_unit: lightProps.witness_list_unit,
    last_ball_unit: lightProps.last_stable_mc_ball_unit,
    last_ball: lightProps.last_stable_mc_ball,
    parent_units: lightProps.parent_units,
    messages: arrMessages,
    authors: [{
      address: utxo.address,
      authentifiers: {},
      definition: utxo.definition
    }]
  };

  objUnit.headers_commission = ObjectLength.getHeadersSize(objUnit);
  objUnit.payload_commission = ObjectLength.getTotalPayloadSize(objUnit);
  objUnit.timestamp = Math.round(Date.now()/1000);

  opts.unit = objUnit;
  opts.signingInfo = {};
  opts.signingInfo[utxo.address] = {
    walletId: utxo.walletId,
    path: utxo.path,
    signingPaths: Object.values(utxo.signingPath)
  };
  opts.testRun = true;

  return opts;
}


module.exports = helpers;
