'use strict';

var _ = require('lodash');
var async = require('async');

var chai = require('chai');
var sinon = require('sinon');
var should = chai.should();
var log = require('npmlog');
log.debug = log.verbose;
log.level = 'info';

var config = require('../test-config');

var Bitcore = require('bitcore-lib');

var Common = require('../../lib/common');
var Utils = Common.Utils;
var Constants = Common.Constants;
var Defaults = Common.Defaults;

var Model = require('../../lib/model');

var WalletService = require('../../lib/server');

var TestData = require('../testdata');
var helpers = require('./helpers');
var storage, blockchainExplorer, request;


describe('Wallet service', function() {

  before(function(done) {
    helpers.before(done);
  });
  beforeEach(function(done) {
    helpers.beforeEach(function(res) {
      storage = res.storage;
      blockchainExplorer = res.blockchainExplorer;
      request = res.request;
      done();
    });
  });
  after(function(done) {
    helpers.after(done);
  });

  describe('#getServiceVersion', function() {
    it('should get version from package', function() {
      WalletService.getServiceVersion().should.equal('ows-' + require('../../package').version);
    });
  });

  describe('#getInstance', function() {
    it('should get server instance', function() {
      var server = WalletService.getInstance({
        clientVersion: 'owc-0.1.0',
      });
      server.clientVersion.should.equal('owc-0.1.0');
    });
    it('should not get server instance for OWC lower than v0.1', function() {
      var err;
      try {
        var server = WalletService.getInstance({
          clientVersion: 'owc-0.0.99',
        });
      } catch (ex) {
        err = ex;
      }
      should.exist(err);
      err.code.should.equal('UPGRADE_NEEDED');
    });
    it('should get server instance for non-OWC clients', function() {
      var server = WalletService.getInstance({
        clientVersion: 'dummy-0.1.0',
      });
      server.clientVersion.should.equal('dummy-0.1.0');
      server = WalletService.getInstance({});
      (server.clientVersion == null).should.be.true;
    });
  });

  describe('#getInstanceWithAuth', function() {
    it('should not get server instance for OWC lower than v0.1', function(done) {
      var server = WalletService.getInstanceWithAuth({
        copayerId: '1234',
        message: 'hello world',
        signature: 'xxx',
        clientVersion: 'owc-0.0.99',
      }, function(err, server) {
        should.exist(err);
        should.not.exist(server);
        err.code.should.equal('UPGRADE_NEEDED');
        done();
      });
    });
    it('should get server instance for existing copayer', function(done) {
      helpers.createAndJoinWallet(1, 2, function(s, wallet) {

        // using copayer 0 data.
        var xpriv = TestData.copayers[0].xPrivKey;
        var priv = TestData.copayers[0].privKey_1H_0;

        var sig = helpers.signMessage('hello world', priv);

        WalletService.getInstanceWithAuth({
          // test assumes wallet's copayer[0] is TestData's copayer[0]
          copayerId: wallet.copayers[0].id,
          message: 'hello world',
          signature: sig,
          clientVersion: 'owc-0.1.0',
          walletId: '123',
        }, function(err, server) {
          should.not.exist(err);
          server.walletId.should.equal(wallet.id);
          server.copayerId.should.equal(wallet.copayers[0].id);
          server.clientVersion.should.equal('owc-0.1.0');
          done();
        });
      });
    });

    it('should fail when requesting for non-existent copayer', function(done) {
      var message = 'hello world';
      var opts = {
        copayerId: 'dummy',
        message: message,
        signature: helpers.signMessage(message, TestData.copayers[0].privKey_1H_0),
      };
      WalletService.getInstanceWithAuth(opts, function(err, server) {
        err.code.should.equal('NOT_AUTHORIZED');
        err.message.should.contain('Copayer not found');
        done();
      });
    });

    it('should fail when message signature cannot be verified', function(done) {
      helpers.createAndJoinWallet(1, 2, function(s, wallet) {
        WalletService.getInstanceWithAuth({
          copayerId: wallet.copayers[0].id,
          message: 'dummy',
          signature: 'dummy',
        }, function(err, server) {
          err.code.should.equal('NOT_AUTHORIZED');
          err.message.should.contain('Invalid signature');
          done();
        });
      });
    });

    it('should get server instance for support staff', function(done) {
      helpers.createAndJoinWallet(1, 1, function(s, wallet) {
        var collections = require('../../lib/storage').collections;
        s.storage.db.collection(collections.COPAYERS_LOOKUP).update({
          copayerId: wallet.copayers[0].id
        }, {
          $set: {
            isSupportStaff: true
          }
        }, () => {

          var xpriv = TestData.copayers[0].xPrivKey;
          var priv = TestData.copayers[0].privKey_1H_0;

          var sig = helpers.signMessage('hello world', priv);

          WalletService.getInstanceWithAuth({
            copayerId: wallet.copayers[0].id,
            message: 'hello world',
            signature: sig,
            walletId: '123',
          }, function(err, server) {
            should.not.exist(err);

            // AQUI
            server.walletId.should.equal('123');
            server.copayerId.should.equal(wallet.copayers[0].id);
            done();
          });

        });
      });
    });
  });

  describe('Session management (#login, #logout, #authenticate)', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 2, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should get a new session & authenticate', function(done) {
      WalletService.getInstanceWithAuth({
        copayerId: server.copayerId,
        session: 'dummy',
      }, function(err, server2) {
        should.exist(err);
        err.code.should.equal('NOT_AUTHORIZED');
        err.message.toLowerCase().should.contain('session');
        should.not.exist(server2);
        server.login({}, function(err, token) {
          should.not.exist(err);
          should.exist(token);
          WalletService.getInstanceWithAuth({
            copayerId: server.copayerId,
            session: token,
          }, function(err, server2) {
            should.not.exist(err);
            should.exist(server2);
            server2.copayerId.should.equal(server.copayerId);
            server2.walletId.should.equal(server.walletId);
            done();
          });
        });
      });
    });
    it('should get the same session token for two requests in a row', function(done) {
      server.login({}, function(err, token) {
        should.not.exist(err);
        should.exist(token);
        server.login({}, function(err, token2) {
          should.not.exist(err);
          token2.should.equal(token);
          done();
        });
      });
    });
    it('should create a new session if the previous one has expired', function(done) {
      var timer = sinon.useFakeTimers({toFake: ['Date']});
      var token;
      async.series([

        function(next) {
          server.login({}, function(err, t) {
            should.not.exist(err);
            should.exist(t);
            token = t;
            next();
          });
        },
        function(next) {
          WalletService.getInstanceWithAuth({
            copayerId: server.copayerId,
            session: token,
          }, function(err, server2) {
            should.not.exist(err);
            should.exist(server2);
            next();
          });
        },
        function(next) {
          timer.tick((Defaults.SESSION_EXPIRATION + 1) * 1000);
          next();
        },
        function(next) {
          server.login({}, function(err, t) {
            should.not.exist(err);
            t.should.not.equal(token);
            next();
          });
        },
        function(next) {
          WalletService.getInstanceWithAuth({
            copayerId: server.copayerId,
            session: token,
          }, function(err, server2) {
            should.exist(err);
            err.code.should.equal('NOT_AUTHORIZED');
            err.message.should.contain('expired');
            next();
          });
        },
      ], function(err) {
        should.not.exist(err);
        timer.restore();
        done();
      });
    });
  });

  describe('#createWallet', function() {
    var server;
    beforeEach(function() {
      server = new WalletService();
    });

    it('should create and store wallet', function(done) {
      var opts = {
        name: 'my wallet',
        m: 2,
        n: 3,
        pubKey: TestData.keyPair.pub,
      };
      server.createWallet(opts, function(err, walletId) {
        should.not.exist(err);
        server.storage.fetchWallet(walletId, function(err, wallet) {
          should.not.exist(err);
          wallet.id.should.equal(walletId);
          wallet.name.should.equal('my wallet');
          done();
        });
      });
    });

    it('should create wallet with given id', function(done) {
      var opts = {
        name: 'my wallet',
        m: 2,
        n: 3,
        pubKey: TestData.keyPair.pub,
        id: '1234',
      };
      server.createWallet(opts, function(err, walletId) {
        should.not.exist(err);
        server.storage.fetchWallet('1234', function(err, wallet) {
          should.not.exist(err);
          wallet.id.should.equal(walletId);
          wallet.name.should.equal('my wallet');
          done();
        });
      });
    });

    it('should fail to create wallets with same id', function(done) {
      var opts = {
        name: 'my wallet',
        m: 2,
        n: 3,
        pubKey: TestData.keyPair.pub,
        id: '1234',
      };
      server.createWallet(opts, function(err, walletId) {
        server.createWallet(opts, function(err, walletId) {
          err.message.should.contain('Wallet already exists');
          done();
        });
      });
    });

    it('should fail to create wallet with no name', function(done) {
      var opts = {
        name: '',
        m: 2,
        n: 3,
        pubKey: TestData.keyPair.pub,
      };
      server.createWallet(opts, function(err, walletId) {
        should.not.exist(walletId);
        should.exist(err);
        err.message.should.contain('name');
        done();
      });
    });

    it('should check m-n combination', function(done) {
      var pairs = [{
        m: 0,
        n: 0,
        valid: false,
      }, {
        m: 1,
        n: 1,
        valid: true,
      }, {
        m: 2,
        n: 3,
        valid: true,
      }, {
        m: 0,
        n: 2,
        valid: false,
      }, {
        m: 2,
        n: 1,
        valid: false,
      }, {
        m: 0,
        n: 10,
        valid: false,
      }, {
        m: 1,
        n: 20,
        valid: false,
      }, {
        m: 10,
        n: 10,
        valid: true,
      }, {
        m: 15,
        n: 15,
        valid: true,
      }, {
        m: 16,
        n: 16,
        valid: false,
      }, {
        m: 1,
        n: 15,
        valid: true,
      }, ];
      var opts = {
        id: '123',
        name: 'my wallet',
        pubKey: TestData.keyPair.pub,
      };
      async.each(pairs, function(pair, cb) {
        opts.m = pair.m;
        opts.n = pair.n;
        server.createWallet(opts, function(err) {
          if (!pair.valid) {
            should.exist(err);
            err.message.should.equal('Invalid combination of required copayers / total copayers');
          } else {
            should.not.exist(err);
          }
          return cb();
        });
      }, function(err) {
        done();
      });
    });

    it('should fail to create wallet with invalid pubKey argument', function(done) {
      var opts = {
        name: 'my wallet',
        m: 2,
        n: 3,
        pubKey: 'dummy',
      };
      server.createWallet(opts, function(err, walletId) {
        should.not.exist(walletId);
        should.exist(err);
        err.message.should.contain('Invalid public key');
        done();
      });
    });

    describe('Address derivation strategy', function() {
      var server;
      beforeEach(function() {
        server = WalletService.getInstance();
      });
      it('should use BIP44 for 1-of-1 wallet if supported', function(done) {
        var walletOpts = {
          name: 'my wallet',
          m: 1,
          n: 1,
          pubKey: TestData.keyPair.pub,
        };
        server.createWallet(walletOpts, function(err, wid) {
          should.not.exist(err);
          server.storage.fetchWallet(wid, function(err, wallet) {
            should.not.exist(err);
            wallet.derivationStrategy.should.equal('BIP44');
            wallet.addressType.should.equal('normal');
            done();
          });
        });
      });
      it('should use BIP44 for shared wallet if supported', function(done) {
        var walletOpts = {
          name: 'my wallet',
          m: 2,
          n: 3,
          pubKey: TestData.keyPair.pub,
        };
        server.createWallet(walletOpts, function(err, wid) {
          should.not.exist(err);
          server.storage.fetchWallet(wid, function(err, wallet) {
            should.not.exist(err);
            wallet.derivationStrategy.should.equal('BIP44');
            wallet.addressType.should.equal('shared');
            done();
          });
        });
      });
    });
  });

  describe('#joinWallet', function() {
    describe('New clients', function() {

      var server, walletId;
      beforeEach(function(done) {
        server = new WalletService();
        var walletOpts = {
          name: 'my wallet',
          m: 1,
          n: 2,
          pubKey: TestData.keyPair.pub,
        };
        server.createWallet(walletOpts, function(err, wId) {
          should.not.exist(err);
          walletId = wId;
          should.exist(walletId);
          done();
        });
      });

      it('should join existing wallet', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          customData: 'dummy custom data',
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          should.not.exist(err);
          var copayerId = result.copayerId;
          helpers.getAuthServer(copayerId, function(server) {
            server.getWallet({}, function(err, wallet) {
              wallet.id.should.equal(walletId);
              wallet.copayers.length.should.equal(1);
              var copayer = wallet.copayers[0];
              copayer.name.should.equal('me');
              copayer.id.should.equal(copayerId);
              copayer.customData.should.equal('dummy custom data');
              server.getNotifications({}, function(err, notifications) {
                should.not.exist(err);
                var notif = _.find(notifications, {
                  type: 'NewCopayer'
                });
                should.exist(notif);
                notif.data.walletId.should.equal(walletId);
                notif.data.copayerId.should.equal(copayerId);
                notif.data.copayerName.should.equal('me');

                notif = _.find(notifications, {
                  type: 'WalletComplete'
                });
                should.not.exist(notif);
                done();
              });
            });
          });
        });
      });

      it('should join existing wallet, getStatus', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          customData: 'dummy custom data',
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          should.not.exist(err);
          var copayerId = result.copayerId;
          helpers.getAuthServer(copayerId, function(server) {
            server.getStatus({
              includeExtendedInfo: true
            }, function(err, status) {
              should.not.exist(err);
              status.wallet.m.should.equal(1);
              should.exist(status.balance);
              done();
            });
          });
        });
      });

      it('should fail join existing wallet with bad xpub', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: 'Ttub4pHUfyVU2mpjaM6YDGDJXWP6j5SL5AJzbViBuTaJEsybcrWZZoGkW7RSUSH9VRQKJtjqY2LfC2bF3FM4UqC1Ba9EP5M64SdTsv9575VAUwh',
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          customData: 'dummy custom data',
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          err.message.should.match(/Invalid extended public key/);
          done();
        });
      });

      it('should fail join existing wallet with wrong network xpub', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: 'tpubD6NzVbkrYhZ4Wbwwqah5kj1RGPK9BYeGbowB1jegxMoAkKbNhYUAcRTZ5fyxDcpjNXxziiy2ZkUQ3kR1ycPNycTD7Q2Dr6UfLcNTYHrzS3U',
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          customData: 'dummy custom data',
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          err.message.should.match(/different network/);
          done();
        });
      });

      it('should fail to join with no name', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: '',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          should.not.exist(result);
          should.exist(err);
          err.message.should.contain('name');
          done();
        });
      });

      it('should fail to join non-existent wallet', function(done) {
        var copayerOpts = {
          walletId: '123',
          name: 'me',
          xPubKey: 'dummy',
          requestPubKey: 'dummy',
          copayerSignature: 'dummy',
          devicePubKey: 'dummy',
          account: 0
        };
        server.joinWallet(copayerOpts, function(err) {
          should.exist(err);
          done();
        });
      });

      it('should fail to join full wallet', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[1].xPrivKey_1H);
        helpers.createAndJoinWallet(1, 1, function(s, wallet) {
          var copayerOpts = helpers.getSignedCopayerOpts({
            walletId: wallet.id,
            name: 'me',
            xPubKey: TestData.copayers[1].xPubKey_44H_0H_0H,
            requestPubKey: TestData.copayers[1].pubKey_1H_0,
            devicePubKey: dxpri.privateKey.toPublicKey(),
            account: 0
          });
          server.joinWallet(copayerOpts, function(err) {
            should.exist(err);
            err.code.should.equal('WALLET_FULL');
            err.message.should.equal('Wallet full');
            done();
          });
        });
      });

      it('should return copayer in wallet error before full wallet', function(done) {
        helpers.createAndJoinWallet(1, 1, function(s, wallet) {
          var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
          var copayerOpts = helpers.getSignedCopayerOpts({
            walletId: wallet.id,
            name: 'me',
            xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
            requestPubKey: TestData.copayers[0].pubKey_1H_0,
            devicePubKey: dxpri.privateKey.toPublicKey(),
            account: 0
          });
          server.joinWallet(copayerOpts, function(err) {
            should.exist(err);
            err.code.should.equal('COPAYER_IN_WALLET');
            done();
          });
        });
      });

      it('should fail to re-join wallet', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err) {
          should.not.exist(err);
          server.joinWallet(copayerOpts, function(err) {
            should.exist(err);
            err.code.should.equal('COPAYER_IN_WALLET');
            err.message.should.equal('Copayer already in wallet');
            done();
          });
        });
      });

      it('should be able to get wallet info without actually joining', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          customData: 'dummy custom data',
          dryRun: true,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          should.not.exist(err);
          should.exist(result);
          should.not.exist(result.copayerId);
          result.wallet.id.should.equal(walletId);
          result.wallet.m.should.equal(1);
          result.wallet.n.should.equal(2);
          result.wallet.copayers.should.be.empty;
          server.storage.fetchWallet(walletId, function(err, wallet) {
            should.not.exist(err);
            wallet.id.should.equal(walletId);
            wallet.copayers.should.be.empty;
            done();
          });
        });
      });

      it('should fail to join two wallets with same xPubKey', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err) {
          should.not.exist(err);

          var walletOpts = {
            name: 'my other wallet',
            m: 1,
            n: 1,
            pubKey: TestData.keyPair.pub,
          };
          server.createWallet(walletOpts, function(err, walletId) {
            should.not.exist(err);
            copayerOpts = helpers.getSignedCopayerOpts({
              walletId: walletId,
              name: 'me',
              xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
              requestPubKey: TestData.copayers[0].pubKey_1H_0,
              devicePubKey: dxpri.privateKey.toPublicKey(),
              account: 0
            });
            server.joinWallet(copayerOpts, function(err) {
              should.exist(err);
              err.code.should.equal('COPAYER_REGISTERED');
              err.message.should.equal('Copayer ID already registered on server');
              done();
            });
          });
        });
      });

      it('should fail to join with bad formated signature', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = {
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          copayerSignature: 'bad sign',
          deviceId: 'invalid',
          account: 0
        };
        server.joinWallet(copayerOpts, function(err) {
          err.message.should.equal('Bad request');
          done();
        });
      });

      it('should fail to join with invalid xPubKey', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'copayer 1',
          xPubKey: 'invalid',
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          should.not.exist(result);
          should.exist(err);
          err.message.should.contain('extended public key');
          done();
        });
      });

      it('should fail to join with null signature', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = {
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          deviceId: 'invalid',
          account: 0
        };
        server.joinWallet(copayerOpts, function(err) {
          should.exist(err);
          err.message.should.contain('argument: copayerSignature missing');
          done();
        });
      });

      it('should fail to join with wrong signature', function(done) {
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_44H_0H_0H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        copayerOpts.name = 'me2';
        server.joinWallet(copayerOpts, function(err) {
          err.message.should.equal('Bad request');
          done();
        });
      });

      it('should set pkr and status = complete on last copayer joining (2-3)', function(done) {
        helpers.createAndJoinWallet(2, 3, function(server) {
          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.status.should.equal('complete');
            wallet.publicKeyRing.length.should.equal(3);
            server.getNotifications({}, function(err, notifications) {
              should.not.exist(err);
              var notif = _.find(notifications, {
                type: 'WalletComplete'
              });
              should.exist(notif);
              notif.data.walletId.should.equal(wallet.id);
              done();
            });
          });
        });
      });

      it('should not notify WalletComplete if 1-of-1', function(done) {
        helpers.createAndJoinWallet(1, 1, function(server) {
          server.getNotifications({}, function(err, notifications) {
            should.not.exist(err);
            var notif = _.find(notifications, {
              type: 'WalletComplete'
            });
            should.not.exist(notif);
            done();
          });
        });
      });
    });
  });

  describe('#removeWallet', function() {
    var server, wallet, clock;

    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 1, function(s, w) {
        server = s;
        wallet = w;

        helpers.stubUtxos(server, wallet, [1, 2], function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 0.1e9,
              }]
            },
          };
          async.eachSeries(_.range(2), function(i, next) {
            helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function() {
              next();
            });
          }, done);
        });
      });
    });

    it('should delete a wallet', function(done) {
      server.removeWallet({}, function(err) {
        should.not.exist(err);
        server.getWallet({}, function(err, w) {
          should.exist(err);
          err.code.should.equal('WALLET_NOT_FOUND');
          should.not.exist(w);
          async.parallel([

            function(next) {
              server.storage.fetchAddresses(wallet.id, function(err, items) {
                items.length.should.equal(0);
                next();
              });
            },
            function(next) {
              server.storage.fetchTxs(wallet.id, {}, function(err, items) {
                items.length.should.equal(0);
                next();
              });
            },
            function(next) {
              server.storage.fetchNotifications(wallet.id, null, 0, function(err, items) {
                items.length.should.equal(0);
                next();
              });
            },

          ], function(err) {
            should.not.exist(err);
            done();
          });
        });
      });
    });

    // creates 2 wallet, and deletes only 1.
    it('should delete a wallet, and only that wallet', function(done) {
      var server2, wallet2;
      async.series([

        function(next) {
          helpers.createAndJoinWallet(1, 1, {
            offset: 1
          }, function(s, w) {
            server2 = s;
            wallet2 = w;

            helpers.stubUtxos(server2, wallet2, [1, 2, 3], function() {
              var txOpts = {
                app: 'payment',
                params: {
                  outputs: [{
                    address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                    amount: 0.1e9,
                  }],
                }
              };
              async.eachSeries(_.range(2), function(i, next) {
                helpers.createAndPublishTx(server2, txOpts, TestData.copayers[1].privKey_1H_0, function() {
                  next();
                });
              }, next);
            });
          });
        },
        function(next) {
          server.removeWallet({}, next);
        },
        function(next) {
          server.getWallet({}, function(err, wallet) {
            should.exist(err);
            err.code.should.equal('WALLET_NOT_FOUND');
            next();
          });
        },
        function(next) {
          server2.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            should.exist(wallet);
            wallet.id.should.equal(wallet2.id);
            next();
          });
        },
        function(next) {
          server2.getMainAddresses({}, function(err, addresses) {
            should.not.exist(err);
            should.exist(addresses);
            addresses.length.should.above(0);
            next();
          });
        },
        function(next) {
          server2.getTxs({}, function(err, txs) {
            should.not.exist(err);
            should.exist(txs);
            txs.length.should.equal(2);
            next();
          });
        },
        function(next) {
          server2.getNotifications({}, function(err, notifications) {
            should.not.exist(err);
            should.exist(notifications);
            notifications.length.should.above(0);
            next();
          });
        },
      ], function(err) {
        should.not.exist(err);
        done();
      });
    });
  });

  describe('#getStatus', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 2, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should get status', function(done) {
      server.getStatus({}, function(err, status) {
        should.not.exist(err);
        should.exist(status);
        should.exist(status.wallet);
        status.wallet.name.should.equal(wallet.name);
        should.exist(status.wallet.copayers);
        status.wallet.copayers.length.should.equal(2);
        should.exist(status.balance);
        should.exist(status.preferences);
        should.exist(status.pendingTxps);
        status.pendingTxps.should.be.empty;

        should.not.exist(status.wallet.publicKeyRing);
        should.not.exist(status.wallet.pubKey);
        should.not.exist(status.wallet.addressManager);
        _.each(status.wallet.copayers, function(copayer) {
          should.not.exist(copayer.xPubKey);
          should.not.exist(copayer.requestPubKey);
          should.not.exist(copayer.signature);
          should.not.exist(copayer.requestPubKey);
          should.not.exist(copayer.addressManager);
          should.not.exist(copayer.customData);
        });
        done();
      });
    });
    it('should get status including extended info', function(done) {
      server.getStatus({
        includeExtendedInfo: true
      }, function(err, status) {
        should.not.exist(err);
        should.exist(status);
        should.exist(status.wallet.publicKeyRing);
        should.exist(status.wallet.pubKey);
        should.exist(status.wallet.addressManager);
        should.exist(status.wallet.copayers[0].xPubKey);
        should.exist(status.wallet.copayers[0].requestPubKey);
        should.exist(status.wallet.copayers[0].signature);
        should.exist(status.wallet.copayers[0].requestPubKey);
        should.exist(status.wallet.copayers[0].customData);
        // Do not return other copayer's custom data
        _.each(_.tail(status.wallet.copayers), function(copayer) {
          should.not.exist(copayer.customData);
        });
        done();
      });
    });
    it('should get status after tx creation', function(done) {
      helpers.stubUtxos(server, wallet, [1, 2], function() {
        var txOpts = {
          app: 'payment',
          params: {
            outputs: [{
              address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
              amount: 0.1e9,
            }],
          }
        };
        helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
          should.exist(tx);
          server.getStatus({}, function(err, status) {
            should.not.exist(err);
            status.pendingTxps.length.should.equal(1);
            var balance = status.balance;
            done();
          });
        });
      });
    });
  });

  describe('#verifyMessageSignature', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 3, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should successfully verify message signature', function(done) {
      var message = 'hello world';
      var opts = {
        message: message,
        signature: helpers.signMessage(message, TestData.copayers[0].privKey_1H_0),
      };
      server.verifyMessageSignature(opts, function(err, isValid) {
        should.not.exist(err);
        isValid.should.be.true;
        done();
      });
    });

    it('should fail to verify message signature for different copayer', function(done) {
      var message = 'hello world';
      var opts = {
        message: message,
        signature: helpers.signMessage(message, TestData.copayers[0].privKey_1H_0),
      };
      helpers.getAuthServer(wallet.copayers[1].id, function(server) {
        server.verifyMessageSignature(opts, function(err, isValid) {
          should.not.exist(err);
          isValid.should.be.false;
          done();
        });
      });
    });
  });

  describe('#createAddress', function() {
    var server, wallet;

    describe('shared wallets (BIP45)', function() {
      beforeEach(function(done) {
        helpers.createAndJoinWallet(2, 2, {
          supportBIP44: false
        }, function(s, w) {
          server = s;
          wallet = w;
          done();
        });
      });

      it('should create address', function(done) {
        server.createAddress({}, function(err, address) {
          should.not.exist(err);
          should.exist(address);
          address.walletId.should.equal(wallet.id);
          address.network.should.equal('livenet');
          address.address.should.equal('LSRE2CBY6MTAEZF3NJGDHU7HFWWWW6AL');
          address.isChange.should.equal(false);
          address.path.should.equal('m/2147483647/0/0');
          address.type.should.equal('shared');
          server.getNotifications({}, function(err, notifications) {
            should.not.exist(err);
            var notif = _.find(notifications, {
              type: 'NewAddress'
            });
            should.exist(notif);
            notif.data.address.should.equal(address.address);
            done();
          });
        });
      });

      it('should create many addresses on simultaneous requests', function(done) {
        var N = 5;
        async.mapSeries(_.range(N), function(i, cb) {
          server.createAddress({}, cb);
        }, function(err, addresses) {
          var x = _.map(addresses, 'path');
          addresses.length.should.equal(N);
          _.each(_.range(N), function(i) {
            addresses[i].path.should.equal('m/2147483647/0/' + i);
          });
          // No two identical addresses
          _.uniq(_.map(addresses, 'address')).length.should.equal(N);
          done();
        });
      });
    });

    describe('shared wallets (BIP44)', function() {
      beforeEach(function(done) {
        helpers.createAndJoinWallet(2, 2, function(s, w) {
          server = s;
          wallet = w;
          done();
        });
      });

      it('should create address ', function(done) {
        server.createAddress({}, function(err, address) {
          should.not.exist(err);
          should.exist(address);
          address.walletId.should.equal(wallet.id);
          address.network.should.equal('livenet');
          address.address.should.equal('JYMRL7V7AG25YAI7DBU7KBXGCRJWDNFP');
          address.isChange.should.equal(false);
          address.coin.should.equal('obyte');
          address.path.should.equal('m/0/0');
          address.type.should.equal('shared');
          server.getNotifications({}, function(err, notifications) {
            should.not.exist(err);
            var notif = _.find(notifications, {
              type: 'NewAddress'
            });
            should.exist(notif);
            notif.data.address.should.equal(address.address);
            done();
          });
        });
      });

      it('should create many addresses on simultaneous requests', function(done) {
        var N = 5;
        async.mapSeries(_.range(N), function(i, cb) {
          server.createAddress({}, cb);
        }, function(err, addresses) {
          addresses.length.should.equal(N);
          _.each(_.range(N), function(i) {
            addresses[i].path.should.equal('m/0/' + i);
          });
          // No two identical addresses
          _.uniq(_.map(addresses, 'address')).length.should.equal(N);
          done();
        });
      });

      it('should not create address if unable to store it', function(done) {
        sinon.stub(server.storage, 'storeAddressAndWallet').yields('dummy error');
        server.createAddress({}, function(err, address) {
          should.exist(err);
          should.not.exist(address);

          server.getMainAddresses({}, function(err, addresses) {
            addresses.length.should.equal(0);

            server.storage.storeAddressAndWallet.restore();
            server.createAddress({}, function(err, address) {
              should.not.exist(err);
              should.exist(address);
              done();
            });
          });
        });
      });
    });

    describe('1-of-1 (BIP44)', function() {
      beforeEach(function(done) {
        helpers.createAndJoinWallet(1, 1, function(s, w) {
          server = s;
          wallet = w;
          w.copayers[0].id.should.equal(TestData.copayers[0].id44);
          done();
        });
      });

      it('should create address', function(done) {
        server.createAddress({}, function(err, address) {
          should.not.exist(err);
          should.exist(address);
          address.walletId.should.equal(wallet.id);
          address.network.should.equal('livenet');
          address.address.should.equal('6HR2V2D64WA3VLM2BRIJGBTTMSMNKMEH');
          address.isChange.should.equal(false);
          address.path.should.equal('m/0/0');
          address.type.should.equal('normal');
          server.getNotifications({}, function(err, notifications) {
            should.not.exist(err);
            var notif = _.find(notifications, {
              type: 'NewAddress'
            });
            should.exist(notif);
            notif.data.address.should.equal(address.address);
            done();
          });
        });
      });

      it('should create many addresses on simultaneous requests', function(done) {
        var N = 5;
        async.mapSeries(_.range(N), function(i, cb) {
          server.createAddress({}, cb);
        }, function(err, addresses) {
          addresses = _.sortBy(addresses, 'path');
          addresses.length.should.equal(N);
          _.each(_.range(N), function(i) {
            addresses[i].path.should.equal('m/0/' + i);
          });
          // No two identical addresses
          _.uniq(_.map(addresses, 'address')).length.should.equal(N);
          done();
        });
      });

      it('should fail to create more consecutive addresses with no activity than allowed', function(done) {
        blockchainExplorer.getAddressActivity = sinon.stub().callsArgWith(1, null, false);
        var MAX_MAIN_ADDRESS_GAP_old = Defaults.MAX_MAIN_ADDRESS_GAP;
        Defaults.MAX_MAIN_ADDRESS_GAP = 2;
        async.map(_.range(2), function(i, next) {
          server.createAddress({}, next);
        }, function(err, addresses) {
          addresses.length.should.equal(2);

          server.createAddress({}, function(err, address) {
            should.exist(err);
            should.not.exist(address);
            err.code.should.equal('MAIN_ADDRESS_GAP_REACHED');
            server.createAddress({
              ignoreMaxGap: true
            }, function(err, address) {
              should.not.exist(err);
              should.exist(address);
              address.path.should.equal('m/0/2');

              Defaults.MAX_MAIN_ADDRESS_GAP = MAX_MAIN_ADDRESS_GAP_old;
              done();
            });
          });
        });
      });
    });
  });

  describe('#getMainAddresses', function() {
    var server, wallet;

    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 2, {}, function(s, w) {
        server = s;
        wallet = w;
        helpers.createAddresses(server, wallet, 5, 0, function() {
          done();
        });
      });
    });

    it('should get all addresses', function(done) {
      server.getMainAddresses({}, function(err, addresses) {
        should.not.exist(err);
        addresses.length.should.equal(5);
        addresses[0].path.should.equal('m/0/0');
        addresses[4].path.should.equal('m/0/4');
        done();
      });
    });
    it('should get first N addresses', function(done) {
      server.getMainAddresses({
        limit: 3
      }, function(err, addresses) {
        should.not.exist(err);
        addresses.length.should.equal(3);
        addresses[0].path.should.equal('m/0/0');
        addresses[2].path.should.equal('m/0/2');
        done();
      });
    });
    it('should get last N addresses in reverse order', function(done) {
      server.getMainAddresses({
        limit: 3,
        reverse: true,
      }, function(err, addresses) {
        should.not.exist(err);
        addresses.length.should.equal(3);
        addresses[0].path.should.equal('m/0/4');
        addresses[2].path.should.equal('m/0/2');
        done();
      });
    });
  });

  describe('Preferences', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 2, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should save & retrieve preferences', function(done) {
      server.savePreferences({
        email: 'dummy@dummy.com',
        language: 'es',
        unit: 'one',
        dummy: 'ignored',
      }, function(err) {
        should.not.exist(err);
        server.getPreferences({}, function(err, preferences) {
          should.not.exist(err);
          should.exist(preferences);
          preferences.email.should.equal('dummy@dummy.com');
          preferences.language.should.equal('es');
          preferences.unit.should.equal('one');
          should.not.exist(preferences.dummy);
          done();
        });
      });
    });
    it('should save preferences only for requesting copayer', function(done) {
      server.savePreferences({
        email: 'dummy@dummy.com'
      }, function(err) {
        should.not.exist(err);
        helpers.getAuthServer(wallet.copayers[1].id, function(server2) {
          server2.getPreferences({}, function(err, preferences) {
            should.not.exist(err);
            should.not.exist(preferences.email);
            done();
          });
        });
      });
    });
    it('should save preferences incrementally', function(done) {
      async.series([

        function(next) {
          server.savePreferences({
            email: 'dummy@dummy.com',
          }, next);
        },
        function(next) {
          server.getPreferences({}, function(err, preferences) {
            should.not.exist(err);
            should.exist(preferences);
            preferences.email.should.equal('dummy@dummy.com');
            should.not.exist(preferences.language);
            next();
          });
        },
        function(next) {
          server.savePreferences({
            language: 'es',
          }, next);
        },
        function(next) {
          server.getPreferences({}, function(err, preferences) {
            should.not.exist(err);
            should.exist(preferences);
            preferences.language.should.equal('es');
            preferences.email.should.equal('dummy@dummy.com');
            next();
          });
        },
        function(next) {
          server.savePreferences({
            language: null,
            unit: 'one',
          }, next);
        },
        function(next) {
          server.getPreferences({}, function(err, preferences) {
            should.not.exist(err);
            should.exist(preferences);
            preferences.unit.should.equal('one');
            should.not.exist(preferences.language);
            preferences.email.should.equal('dummy@dummy.com');
            next();
          });
        },
      ], function(err) {
        should.not.exist(err);
        done();
      });
    });
    it('should validate entries', function(done) {
      var invalid = [{
        preferences: {
          email: ' ',
        },
        expected: 'email'
      }, {
        preferences: {
          email: 'dummy@' + _.repeat('domain', 50),
        },
        expected: 'email'
      }, {
        preferences: {
          language: 'xxxxx',
        },
        expected: 'language'
      }, {
        preferences: {
          language: 123,
        },
        expected: 'language'
      }, {
        preferences: {
          unit: 'xxxxx',
        },
        expected: 'unit'
      }, ];
      async.each(invalid, function(item, next) {
        server.savePreferences(item.preferences, function(err) {
          should.exist(err);
          err.message.should.contain(item.expected);
          next();
        });
      }, done);
    });
  });

  describe('#getUtxos', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 1, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should get UTXOs for wallet addresses', function(done) {
      helpers.stubUtxos(server, wallet, [1, 2], function() {
        server.getUtxos({}, function(err, utxos) {
          should.not.exist(err);
          should.exist(utxos);
          utxos.length.should.equal(2);
          _.sumBy(utxos, 'amount').should.equal(3 * 1e9);
          server.getMainAddresses({}, function(err, addresses) {
            var utxo = utxos[0];
            var address = _.find(addresses, {
              address: utxo.address
            });
            should.exist(address);
            utxo.path.should.equal(address.path);
            utxo.definition.should.deep.equal(address.definition);
            done();
          });
        });
      });
    });

    it('should return empty UTXOs for specific addresses if mismatch', function(done) {
      helpers.stubUtxos(server, wallet, [1, 2, 3], function(utxos) {
        _.uniqBy(utxos, 'address').length.should.be.above(1);
        var address = utxos[0].address;
        var amount = _.sumBy(_.filter(utxos, {
          address: address
        }), 'amount');
        server.getUtxos({
          addresses: ['K5GFUATCWHAUNTGCZRHOXDIEJ7JEQMRN']
        }, function(err, utxos) {
          should.not.exist(err);
          utxos.should.be.empty();
          done();
        });
      });
    });
 
    it('should  get UTXOs for specific addresses', function(done) {
      server.createAddress({}, function(err, address) {
        helpers.stubUtxos(server, wallet, [1, 2, 3], {addresses:[address]}, function(utxos) {
          server.getUtxos({
            addresses: [address.address]
          }, function(err, utxos) {
            utxos.length.should.equal(3);
            done();
          });
        });
      });
    });

    it('should not fail when getting UTXOs for wallet with 0 UTXOs and pending txps', function(done) {
      helpers.stubUtxos(server, wallet, [1, 1], function() {
        var txOpts = {
          app: 'payment',
          params: {
            outputs: [{
              address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
              amount: 1e8,
            }],
          }
        };
        helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
          blockchainExplorer.getUtxos = function(addresses, asset, cb) {
            return cb(null, []);
          };

          server.getUtxos({}, function(err, utxos) {
            should.not.exist(err);
            utxos.should.be.empty;
            done();
          });
        });
      });
    });
  });

  describe('Multiple request Pub Keys', function() {
    var server, wallet;
    var opts, reqPrivKey, ws;
    var getAuthServer = function(copayerId, privKey, cb) {
      var msg = 'dummy';
      var sig = helpers.signMessage(msg, privKey);
      WalletService.getInstanceWithAuth({
        copayerId: copayerId,
        message: msg,
        signature: sig,
        clientVersion: helpers.CLIENT_VERSION,
      }, function(err, server) {
        return cb(err, server);
      });
    };

    beforeEach(function() {
      reqPrivKey = new Bitcore.PrivateKey();
      var requestPubKey = reqPrivKey.toPublicKey();

      var xPrivKey = TestData.copayers[0].xPrivKey_44H_0H_0H;
      var requestPubKeyStr = requestPubKey.toString();
      var sig = helpers.signRequestPubKey(requestPubKeyStr, xPrivKey);

      var copayerId = Model.Copayer._xPubToCopayerId('obyte', TestData.copayers[0].xPubKey_44H_0H_0H);
      opts = {
        copayerId: copayerId,
        requestPubKey: requestPubKeyStr,
        signature: sig,
      };
      ws = new WalletService();
    });

    describe('#addAccess 1-1', function() {
      beforeEach(function(done) {
        helpers.createAndJoinWallet(1, 1, function(s, w) {
          server = s;
          wallet = w;

          helpers.stubUtxos(server, wallet, 1, function() {
            done();
          });
        });
      });

      it('should be able to re-gain access from xPrivKey', function(done) {
        ws.addAccess(opts, function(err, res) {
          should.not.exist(err);
          res.wallet.copayers[0].requestPubKeys.length.should.equal(2);
          res.wallet.copayers[0].requestPubKeys[0].selfSigned.should.equal(true);

          server.getBalance(res.wallet.walletId, function(err, bal) {
            should.not.exist(err);
            bal.base.stable.should.equal(1e9);
            getAuthServer(opts.copayerId, reqPrivKey, function(err, server2) {

              server2.getBalance(res.wallet.walletId, function(err, bal2) {
                should.not.exist(err);
                bal2.base.stable.should.equal(1e9);
                done();
              });
            });
          });
        });
      });

      it('should fail to gain access with wrong xPrivKey', function(done) {
        opts.signature = 'xx';
        ws.addAccess(opts, function(err, res) {
          err.code.should.equal('NOT_AUTHORIZED');
          done();
        });
      });

      it('should fail to access with wrong privkey after gaining access', function(done) {
        ws.addAccess(opts, function(err, res) {
          should.not.exist(err);
          server.getBalance(res.wallet.walletId, function(err, bal) {
            should.not.exist(err);
            var privKey = new Bitcore.PrivateKey();
            getAuthServer(opts.copayerId, privKey, function(err, server2) {
              err.code.should.equal('NOT_AUTHORIZED');
              done();
            });
          });
        });
      });

      it('should be able to create TXs after regaining access', function(done) {
        ws.addAccess(opts, function(err, res) {
          should.not.exist(err);
          getAuthServer(opts.copayerId, reqPrivKey, function(err, server2) {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 0.8e8
                }],
              }
            };
            txOpts = helpers.composeJoint(txOpts);
            server2.createTx(txOpts, function(err, tx) {
              should.not.exist(err);
              done();
            });
          });
        });
      });
    });

    describe('#addAccess 2-2', function() {
      beforeEach(function(done) {
        helpers.createAndJoinWallet(2, 2, function(s, w) {
          server = s;
          wallet = w;
          helpers.stubUtxos(server, wallet, 1, function() {
            done();
          });
        });
      });

      it('should be able to re-gain access from xPrivKey', function(done) {
        ws.addAccess(opts, function(err, res) {
          should.not.exist(err);
          server.getBalance(res.wallet.walletId, function(err, bal) {
            should.not.exist(err);
            bal.base.stable.should.equal(1e9);
            getAuthServer(opts.copayerId, reqPrivKey, function(err, server2) {
              server2.getBalance(res.wallet.walletId, function(err, bal2) {
                should.not.exist(err);
                bal2.base.stable.should.equal(1e9);
                done();
              });
            });
          });
        });
      });

      it('TX proposals should include info to be verified', function(done) {
        ws.addAccess(opts, function(err, res) {
          should.not.exist(err);
          getAuthServer(opts.copayerId, reqPrivKey, function(err, server2) {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 0.8e8
                }],
              }
            };
            helpers.createAndPublishTx(server, txOpts, reqPrivKey, function() {
              server2.getPendingTxs({}, function(err, txs) {
                should.not.exist(err);
                should.exist(txs[0].proposalSignaturePubKey);
                should.exist(txs[0].proposalSignaturePubKeySig);
                done();
              });
            });
          });
        });
      });
    });
  });

  describe('#getBalance', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 1, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should get balance', function(done) {
      helpers.stubUtxos(server, wallet, [1, 2, 3], function() {
        server.getBalance({}, function(err, balance) {
          should.not.exist(err);
          should.exist(balance);
          balance.base.stable.should.equal(6e9);
          balance.base.pending.should.equal(0);
          balance.base.stable_outputs_count.should.equal(3);
          balance.base.pending_outputs_count.should.equal(0);
          done();
        });
      });
    });

    it('should get balance when there are no addresses', function(done) {
      server.getBalance({}, function(err, balance) {
        should.not.exist(err);
        should.exist(balance);
        balance.base.stable.should.equal(0);
        balance.base.pending.should.equal(0);
        balance.base.stable_outputs_count.should.equal(0);
        balance.base.pending_outputs_count.should.equal(0);
        done();
      });
    });

    it('should get balance when there are no funds', function(done) {
      blockchainExplorer.getBalance = sinon.stub().callsArgWith(2, null, { base: { stable: 0, pending: 0, stable_outputs_count: 0, pending_outputs_count: 0 } });
      server.createAddress({}, function(err, address) {
        should.not.exist(err);
        server.getBalance({}, function(err, balance) {
          should.not.exist(err);
          should.exist(balance);
          balance.base.stable.should.equal(0);
          balance.base.pending.should.equal(0);
          balance.base.stable_outputs_count.should.equal(0);
          balance.base.pending_outputs_count.should.equal(0);
          done();
        });
      });
    });

    it('should fail gracefully when blockchain is unreachable', function(done) {
      blockchainExplorer.getBalance = sinon.stub().callsArgWith(2, 'dummy error');
      server.createAddress({}, function(err, address) {
        should.not.exist(err);
        server.getBalance({}, function(err, balance) {
          should.exist(err);
          err.toString().should.equal('dummy error');
          done();
        });
      });
    });
  });

  describe('Wallet not complete tests', function() {
    it('should fail to create address when wallet is not complete', function(done) {
      var server = new WalletService();
      var walletOpts = {
        name: 'my wallet',
        m: 2,
        n: 3,
        pubKey: TestData.keyPair.pub,
      };
      server.createWallet(walletOpts, function(err, walletId) {
        should.not.exist(err);
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_45H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          should.not.exist(err);
          helpers.getAuthServer(result.copayerId, function(server) {
            server.createAddress({}, function(err, address) {
              should.not.exist(address);
              should.exist(err);
              err.code.should.equal('WALLET_NOT_COMPLETE');
              err.message.should.equal('Wallet is not complete');
              done();
            });
          });
        });
      });
    });

    it('should fail to create tx when wallet is not complete', function(done) {
      var server = new WalletService();
      var walletOpts = {
        name: 'my wallet',
        m: 2,
        n: 3,
        pubKey: TestData.keyPair.pub,
      };
      server.createWallet(walletOpts, function(err, walletId) {
        should.not.exist(err);
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[0].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'me',
          xPubKey: TestData.copayers[0].xPubKey_45H,
          requestPubKey: TestData.copayers[0].pubKey_1H_0,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          should.not.exist(err);
          helpers.getAuthServer(result.copayerId, function(server, wallet) {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 0.8e8
                }],
              }
            };
            server.createTx(txOpts, function(err, tx) {
              should.not.exist(tx);
              should.exist(err);
              err.code.should.equal('WALLET_NOT_COMPLETE');
              done();
            });
          });
        });
      });
    });
  });
  
  describe('#createTx', function() {
    describe('Tx proposal creation & publishing ', function() {
      var server, wallet;
      beforeEach(function(done) {
        helpers.createAndJoinWallet(1, 1, { 
          coin: 'obyte',
        },  function(s, w) {
          server = s;
          wallet = w;
          done();
        });
      });

      it('should create a tx', function(done) {
        helpers.stubUtxos(server, wallet, [1, 2], function() {
          let amount = 0.8 * 1e8;
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: amount,
              }],
            }, 
            message: 'some message',
            customData: 'some custom data'
          };
          txOpts = helpers.composeJoint(txOpts);
          server.createTx(txOpts, function(err, tx) {
            should.not.exist(err);
            should.exist(tx);
            tx.walletM.should.equal(1);
            tx.walletN.should.equal(1);
            tx.requiredRejections.should.equal(1);
            tx.requiredSignatures.should.equal(1);
            tx.isAccepted().should.equal.false;
            tx.isRejected().should.equal.false;
            tx.isPending().should.equal.true;
            tx.isTemporary().should.equal.true;

            server.getPendingTxs({}, function(err, txs) {
              should.not.exist(err);
              txs.should.be.empty;
              done();
            });
          });
        });
      });

      describe('Validations', function() {
        it('should fail to create a tx without outputs', function(done) {
          helpers.stubUtxos(server, wallet, [1, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [],
              },
            };
            server.createTx(txOpts, function(err, tx) {
              should.exist(err);
              should.not.exist(tx);
              err.message.should.equal('No outputs were specified');
              done();
            });
          });
        });
  
        it('should fail to create tx for invalid address', function(done) {
          helpers.stubUtxos(server, wallet, 1, function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: 'invalid address',
                  amount: 0.5e8
                }],
              },
            };
            server.createTx(txOpts, function(err, tx) {
              should.exist(err);
              should.not.exist(tx);
              // may fail due to Non-base58 character, or Checksum mismatch, or other
              done();
            });
          });
        });

        it('should fail to create tx for invalid amount', function(done) {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 0,
              }],
            },
          };
          server.createTx(txOpts, function(err, tx) {
            should.not.exist(tx);
            should.exist(err);
            err.message.should.equal('Invalid amount');
            done();
          });
        });

        it('should be able to specify change address', function(done) {
          helpers.stubUtxos(server, wallet, [1, 2], function(utxos) {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 0.8e8,
                }],
                change_address: utxos[0].address,
              }
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, tx) {
              should.not.exist(err);
              should.exist(tx);
              tx.changeAddress.should.equal(txOpts.params.change_address);
              done();
            });
          });
        });

        it('should be fail if specified change address is not from the wallet', function(done) {
          helpers.stubUtxos(server, wallet, [1, 2], function(utxos) {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 0.8e8,
                }],
                change_address: '4QRPWEA43LCHY2AK7LM2MCUHFHEGT7HW',
              }
            };
            txOpts = helpers.composeJoint(txOpts);            
            server.createTx(txOpts, function(err, tx) {
              should.exist(err);
              err.code.should.equal('INVALID_CHANGE_ADDRESS');
              done();
            });
          });
        });
      });

      describe('Foreign ID', function() {
        it('should create a tx with foreign ID', function(done) {
          helpers.stubUtxos(server, wallet, 2, function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              txProposalId: '123'
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, tx) {
              should.not.exist(err);
              should.exist(tx);
              tx.id.should.equal('123');
              done();
            });
          });
        });

        it('should return already created tx if same foreign ID is specified and tx still unpublished', function(done) {
          helpers.stubUtxos(server, wallet, 2, function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              txProposalId: '123'
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, tx) {
              should.not.exist(err);
              should.exist(tx);
              tx.id.should.equal('123');
              server.createTx(txOpts, function(err, tx) {
                should.not.exist(err);
                should.exist(tx);
                tx.id.should.equal('123');
                server.storage.fetchTxs(wallet.id, {}, function(err, txs) {
                  should.not.exist(err);
                  should.exist(txs);
                  txs.length.should.equal(1);
                  done();
                });
              });
            });
          });
        });

        it('should return already published tx if same foreign ID is specified and tx already published', function(done) {
          helpers.stubUtxos(server, wallet, [2, 2, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              txProposalId: '123'
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, tx) {
              should.not.exist(err);
              should.exist(tx);
              tx.id.should.equal('123');
              var publishOpts = helpers.getProposalSignatureOpts(tx, TestData.copayers[0].privKey_1H_0);
              server.publishTx(publishOpts, function(err, tx) {
                should.not.exist(err);
                should.exist(tx);
                server.createTx(txOpts, function(err, tx) {
                  should.not.exist(err);
                  should.exist(tx);
                  tx.id.should.equal('123');
                  tx.status.should.equal('pending');
                  server.storage.fetchTxs(wallet.id, {}, function(err, txs) {
                    should.not.exist(err);
                    txs.length.should.equal(1);
                    done();
                  });
                });
              });
            });
          });
        });
      });

      describe('Publishing', function() {
        it('should be able to publish a temporary tx proposal', function(done) {
          helpers.stubUtxos(server, wallet, [1, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              message: 'some message',
              customData: 'some custom data'
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, txp) {
              should.not.exist(err);
              should.exist(txp);
              var publishOpts = helpers.getProposalSignatureOpts(txp, TestData.copayers[0].privKey_1H_0);
              server.publishTx(publishOpts, function(err) {
                should.not.exist(err);
                server.getPendingTxs({}, function(err, txs) {
                  should.not.exist(err);
                  txs.length.should.equal(1);
                  should.exist(txs[0].proposalSignature);
                  done();
                });
              });
            });
          });
        });

        it('should not be able to publish a temporary tx proposal created in a dry run', function(done) {
          helpers.stubUtxos(server, wallet, [1, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              dryRun: true
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, txp) {
              should.not.exist(err);
              should.exist(txp);
              var publishOpts = helpers.getProposalSignatureOpts(txp, TestData.copayers[0].privKey_1H_0);
              server.publishTx(publishOpts, function(err) {
                should.exist(err);
                err.code.should.equal('TX_NOT_FOUND');
                server.getPendingTxs({}, function(err, txs) {
                  should.not.exist(err);
                  txs.length.should.equal(0);
                  done();
                });
              });
            });
          });
        });

        it('should delay NewTxProposal notification until published', function(done) {
          helpers.stubUtxos(server, wallet, [1, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              message: 'some message'
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, txp) {
              should.not.exist(err);
              should.exist(txp);
              server.getNotifications({}, function(err, notifications) {
                should.not.exist(err);
                _.map(notifications, 'type').should.not.contain('NewTxProposal');
                var publishOpts = helpers.getProposalSignatureOpts(txp, TestData.copayers[0].privKey_1H_0);
                server.publishTx(publishOpts, function(err) {
                  should.not.exist(err);
                  server.getNotifications({}, function(err, notifications) {
                    should.not.exist(err);

                    var n = _.find(notifications, {
                      'type': 'NewTxProposal'
                    });
                    should.exist(n);
                    should.exist(n.data.txProposalId);
                    should.exist(n.data.message);
                    should.exist(n.data.creatorId);
                    n.data.creatorId.should.equal(server.copayerId);
                    done();
                  });
                });
              });
            });
          });
        });

        it('should fail to publish non-existent tx proposal', function(done) {
          server.publishTx({
            txProposalId: 'wrong-id',
            proposalSignature: 'dummy',
          }, function(err) {
            should.exist(err);
            server.getPendingTxs({}, function(err, txs) {
              should.not.exist(err);
              txs.should.be.empty;
              done();
            });
          });
        });

        it('should fail to publish tx proposal with wrong signature', function(done) {
          helpers.stubUtxos(server, wallet, [1, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              message: 'some message'
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, txp) {
              should.not.exist(err);
              should.exist(txp);
              server.publishTx({
                txProposalId: txp.id,
                proposalSignature: 'dummy'
              }, function(err) {
                should.exist(err);
                err.message.should.contain('Invalid proposal signature');
                done();
              });
            });
          });
        });

        it('should fail to publish tx proposal not signed by the creator', function(done) {
          helpers.stubUtxos(server, wallet, [1, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              message: 'some message'
            };
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, txp) {
              should.not.exist(err);
              should.exist(txp);

              var publishOpts = helpers.getProposalSignatureOpts(txp, TestData.copayers[1].privKey_1H_0);

              server.publishTx(publishOpts, function(err) {
                should.exist(err);
                err.message.should.contain('Invalid proposal signature');
                done();
              });
            });
          });
        });

        it('should fail to publish a temporary tx proposal if utxos are locked by other pending proposals', function(done) {
          var txp1, txp2;
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 1e8,
              }],
            }
          };
          
          async.waterfall([
            function(next) {
              helpers.stubUtxos(server, wallet, [1, 2], function() {
                next();
              });
            },
            function(next) {
              txOpts = helpers.composeJoint(txOpts);
              server.createTx(txOpts, next);
            },
            function(txp, next) {
              txp1 = txp;
              server.createTx(txOpts, next);
            },
            function(txp, next) {
              txp2 = txp;
              should.exist(txp1);
              should.exist(txp2);
              var publishOpts = helpers.getProposalSignatureOpts(txp1, TestData.copayers[0].privKey_1H_0);
              server.publishTx(publishOpts, next);
            },
            function(txp, next) {
              var publishOpts = helpers.getProposalSignatureOpts(txp2, TestData.copayers[0].privKey_1H_0);
              server.publishTx(publishOpts, function(err) {
                should.exist(err);
                err.code.should.equal('UNAVAILABLE_UTXOS');
                next();
              });
            },
            function(next) {
              server.getPendingTxs({}, function(err, txs) {
                should.not.exist(err);
                txs.length.should.equal(1);
                next();
              });
            },
            function(next) {
              // A new tx proposal should use the next available UTXO
              txOpts = helpers.composeJoint(txOpts);
              server.createTx(txOpts, next);
            },
            function(txp3, next) {
              should.exist(txp3);
              var publishOpts = helpers.getProposalSignatureOpts(txp3, TestData.copayers[0].privKey_1H_0);
              server.publishTx(publishOpts, next);
            },
            function(txp, next) {
              server.getPendingTxs({}, function(err, txs) {
                should.not.exist(err);
                txs.length.should.equal(2);
                next();
              });
            },
          ], function(err) {
            should.not.exist(err);
            done();
          });
        });

      });

      it('should generate new change address for each created tx', function(done) {
        helpers.stubUtxos(server, wallet, [1, 2], function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 1e8,
              }],
            }
          };
          txOpts = helpers.composeJoint(txOpts);
          server.createTx(txOpts, function(err, tx1) {
            should.not.exist(err);
            should.exist(tx1);
            server.createTx(txOpts, function(err, tx2) {
              should.not.exist(err);
              should.exist(tx2);
              tx1.changeAddress.should.not.equal(tx2.changeAddress);
              done();
            });
          });
        });
      });

      it('should create tx when there is a pending tx and enough UTXOs', function(done) {
        helpers.stubUtxos(server, wallet, [1.1, 1.2, 1.3], function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 1e9,
              }],
            }
          };
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
            should.exist(tx);
            txOpts.params.outputs[0].amount = 1.2e9;
            helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
              should.exist(tx);
              server.getPendingTxs({}, function(err, txs) {
                should.not.exist(err);
                txs.length.should.equal(2);
                server.getBalance({}, function(err, balance) {
                  should.not.exist(err);
                  balance.base.stable.should.equal(1.3e9);
                  balance.base.pending.should.equal(0);
                  done();
                });
              });
            });
          });
        });
      });

      it('should accept a tx proposal signed with a custom key', function(done) {
        var reqPrivKey = new Bitcore.PrivateKey();
        var reqPubKey = reqPrivKey.toPublicKey().toString();

        var xPrivKey = TestData.copayers[0].xPrivKey_44H_0H_0H;

        var accessOpts = {
          copayerId: TestData.copayers[0].id44,
          requestPubKey: reqPubKey,
          signature: helpers.signRequestPubKey(reqPubKey, xPrivKey),
        };

        server.addAccess(accessOpts, function(err) {
          should.not.exist(err);

          helpers.stubUtxos(server, wallet, [1, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 1e8,
                }],
              },
              message: 'some message'
            };
            
            txOpts = helpers.composeJoint(txOpts);
            server.createTx(txOpts, function(err, txp) {
              should.not.exist(err);
              should.exist(txp);

              var publishOpts = helpers.getProposalSignatureOpts(txp, reqPrivKey);

              server.publishTx(publishOpts, function(err) {
                should.not.exist(err);
                server.getTx({
                  txProposalId: txp.id
                }, function(err, x) {
                  should.not.exist(err);
                  x.proposalSignature.should.equal(publishOpts.proposalSignature);
                  x.proposalSignaturePubKey.should.equal(accessOpts.requestPubKey);
                  x.proposalSignaturePubKeySig.should.equal(accessOpts.signature);
                  done();
                });
              });
            });
          });
        });
      });
    });
  });

  describe('Backoff time', function(done) {
    var server, wallet, txid, clock;
    var _oldBackoffOffset = Defaults.BACKOFF_OFFSET;
    beforeEach(function(done) {
      Defaults.BACKOFF_OFFSET = 3;
      helpers.createAndJoinWallet(2, 2, function(s, w) {
        server = s;
        wallet = w;
        helpers.stubUtxos(server, wallet, _.range(2, 10), function() {
          done();
        });
      });
    });
    afterEach(function(done) {
      Defaults.BACKOFF_OFFSET = _oldBackoffOffset;
      clock.restore();
      done();
    });

    it('should follow backoff time after consecutive rejections', function(done) {
      this.timeout(5000);
      clock = sinon.useFakeTimers({now: Date.now(), toFake: ['Date']});
      var txOpts = {
        app: 'payment',
        params: {
          outputs: [{
            address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
            amount: 1e8,
          }],
        }
      }
      async.series([

        function(next) {
          async.each(_.range(3), function(i, next) {
              helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
                server.rejectTx({
                  txProposalId: tx.id,
                  reason: 'some reason',
                }, next);
              });
            },
            next);
        },
        function(next) {
          // Allow a 4th tx
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
            server.rejectTx({
              txProposalId: tx.id,
              reason: 'some reason',
            }, next);
          });
        },
        function(next) {
          // Do not allow before backoff time
          server.createTx(txOpts, function(err, tx) {
            should.exist(err);
            err.code.should.equal('TX_CANNOT_CREATE');
            next();
          });
        },
        function(next) {
          clock.tick((Defaults.BACKOFF_TIME + 1) * 1000);
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
            server.rejectTx({
              txProposalId: tx.id,
              reason: 'some reason',
            }, next);
          });
        },
        function(next) {
          // Do not allow a 5th tx before backoff time
          clock.tick((Defaults.BACKOFF_TIME - 1) * 1000);
          server.createTx(txOpts, function(err, tx) {
            should.exist(err);
            err.code.should.equal('TX_CANNOT_CREATE');
            next();
          });
        },
        function(next) {
          clock.tick(2000);
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
            server.rejectTx({
              txProposalId: tx.id,
              reason: 'some reason',
            }, next);
          });
        },
      ], function(err) {
        should.not.exist(err);
        done();
      });
    });
  });

  describe('Transaction notes', function(done) {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 2, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should edit a note for an arbitrary txid', function(done) {
      server.editTxNote({
        txid: '123',
        body: 'note body'
      }, function(err, note) {
        should.not.exist(err);
        note.txid.should.equal('123');
        note.walletId.should.equal(wallet.id);
        note.body.should.equal('note body');
        note.editedBy.should.equal(server.copayerId);
        note.editedByName.should.equal('copayer 1');
        note.createdOn.should.equal(note.editedOn);
        server.getTxNote({
          txid: '123',
        }, function(err, note) {
          should.not.exist(err);
          should.exist(note);
          note.body.should.equal('note body');
          note.editedBy.should.equal(server.copayerId);
          done();
        });
      });
    });
    it('should preserve last edit', function(done) {
      var clock = sinon.useFakeTimers({toFake: ['Date']});
      server.editTxNote({
        txid: '123',
        body: 'note body'
      }, function(err) {
        should.not.exist(err);
        server.getTxNote({
          txid: '123',
        }, function(err, note) {
          should.not.exist(err);
          should.exist(note);
          note.editedBy.should.equal(server.copayerId);
          note.createdOn.should.equal(note.editedOn);
          var creator = note.editedBy;
          helpers.getAuthServer(wallet.copayers[1].id, function(server) {
            clock.tick(60 * 1000);
            server.editTxNote({
              txid: '123',
              body: 'edited text'
            }, function(err) {
              should.not.exist(err);
              server.getTxNote({
                txid: '123',
              }, function(err, note) {
                should.not.exist(err);
                should.exist(note);
                note.editedBy.should.equal(server.copayerId);
                note.createdOn.should.be.below(note.editedOn);
                creator.should.not.equal(note.editedBy);
                clock.restore();
                done();
              });
            });
          });
        });
      });
    });
    it('should edit a note for an outgoing tx and retrieve it', function(done) {
      helpers.stubUtxos(server, wallet, 2, function() {
        var txOpts = {
          app: 'payment',
          params: {
            outputs: [{
              address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
              amount: 1e8,
            }],
          }
        };
        helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
          should.exist(txp);
          var signatures = helpers.clientSign(txp, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
          server.signTx({
            txProposalId: txp.id,
            signatures: signatures,
          }, function(err, txp) {
            should.not.exist(err);
            should.exist(txp);
            should.exist(txp.txid);
            server.editTxNote({
              txid: txp.txid,
              body: 'note body'
            }, function(err) {
              should.not.exist(err);
              server.getTx({
                txProposalId: txp.id,
              }, function(err, txp) {
                should.not.exist(err);
                should.exist(txp.note);
                txp.note.txid.should.equal(txp.txid);
                txp.note.walletId.should.equal(wallet.id);
                txp.note.body.should.equal('note body');
                txp.note.editedBy.should.equal(server.copayerId);
                done();
              });
            });
          });
        });
      });
    });
    it('should share notes between copayers', function(done) {
      server.editTxNote({
        txid: '123',
        body: 'note body'
      }, function(err) {
        should.not.exist(err);
        server.getTxNote({
          txid: '123',
        }, function(err, note) {
          should.not.exist(err);
          should.exist(note);
          note.editedBy.should.equal(server.copayerId);
          var creator = note.editedBy;
          helpers.getAuthServer(wallet.copayers[1].id, function(server) {
            server.getTxNote({
              txid: '123',
            }, function(err, note) {
              should.not.exist(err);
              should.exist(note);
              note.body.should.equal('note body');
              note.editedBy.should.equal(creator);
              done();
            });
          });
        });
      });
    });
    it('should be possible to set an empty note', function(done) {
      server.editTxNote({
        txid: '123',
        body: 'note body'
      }, function(err) {
        should.not.exist(err);
        server.getTxNote({
          txid: '123',
        }, function(err, note) {
          should.not.exist(err);
          should.exist(note);
          server.editTxNote({
            txid: '123',
            body: null,
          }, function(err) {
            should.not.exist(err);
            server.getTxNote({
              txid: '123',
            }, function(err, note) {
              should.not.exist(err);
              should.exist(note);
              note.should.have.property('body');
              should.equal(note.body, null);
              server.getTxNotes({
                minTs: 0
              }, function(err, notes) {
                should.not.exist(err);
                should.exist(notes);
                notes.length.should.equal(1);
                should.equal(notes[0].body, null);
                done();
              });
            });
          });
        });
      });
    });
    it('should include the note in tx history listing', function(done) {
      helpers.createAddresses(server, wallet, 1, 1, function(mainAddresses, changeAddress) {
        var txs = [{
          unit: '123',
          time: 1552832680
        }];
        helpers.stubHistory(txs);
        server.editTxNote({
          txid: '123',
          body: 'just some note'
        }, function(err) {
          should.not.exist(err);
          server.getTxHistory({}, function(err, txs) {
            should.not.exist(err);
            should.exist(txs);
            txs.length.should.equal(1);
            var tx = txs[0];
            should.exist(tx.note);
            tx.note.body.should.equal('just some note');
            tx.note.editedBy.should.equal(server.copayerId);
            should.exist(tx.note.editedOn);
            done();
          });
        });
      });
    });
    it('should get all notes edited past a given date', function(done) {
      var clock = sinon.useFakeTimers({toFake: ['Date']});
      async.series([

        function(next) {
          server.getTxNotes({}, function(err, notes) {
            should.not.exist(err);
            notes.should.be.empty;
            next();
          });
        },
        function(next) {
          server.editTxNote({
            txid: '123',
            body: 'note body'
          }, next);
        },
        function(next) {
          server.getTxNotes({
            minTs: 0,
          }, function(err, notes) {
            should.not.exist(err);
            notes.length.should.equal(1);
            notes[0].txid.should.equal('123');
            next();
          });
        },
        function(next) {
          clock.tick(60 * 1000);
          server.editTxNote({
            txid: '456',
            body: 'another note'
          }, next);
        },
        function(next) {
          server.getTxNotes({
            minTs: 0,
          }, function(err, notes) {
            should.not.exist(err);
            notes.length.should.equal(2);
            _.difference(_.map(notes, 'txid'), ['123', '456']).should.be.empty;
            next();
          });
        },
        function(next) {
          server.getTxNotes({
            minTs: 50,
          }, function(err, notes) {
            should.not.exist(err);
            notes.length.should.equal(1);
            notes[0].txid.should.equal('456');
            next();
          });
        },
        function(next) {
          clock.tick(60 * 1000);
          server.editTxNote({
            txid: '123',
            body: 'an edit'
          }, next);
        },
        function(next) {
          server.getTxNotes({
            minTs: 100,
          }, function(err, notes) {
            should.not.exist(err);
            notes.length.should.equal(1);
            notes[0].txid.should.equal('123');
            notes[0].body.should.equal('an edit');
            next();
          });
        },
        function(next) {
          server.getTxNotes({}, function(err, notes) {
            should.not.exist(err);
            notes.length.should.equal(2);
            next();
          });
        },
      ], function(err) {
        should.not.exist(err);
        clock.restore();
        done();
      });
    });
  });

  describe('Single-address wallet', function() {
    var server, wallet, firstAddress;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 2, {
        singleAddress: true,
      }, function(s, w) {
        server = s;
        wallet = w;
        server.createAddress({}, function(err, a) {
          should.not.exist(err);
          should.exist(a.address);
          firstAddress = a;
          done();
        });
      });
    });

    it('should include singleAddress property', function(done) {
      server.getWallet({}, function(err, wallet) {
        should.not.exist(err);
        wallet.singleAddress.should.be.true;
        done();
      });
    });

    it('should always return same address', function(done) {
      firstAddress.path.should.equal('m/0/0');
      server.createAddress({}, function(err, x) {
        should.not.exist(err);
        should.exist(x);
        x.path.should.equal('m/0/0');
        x.address.should.equal(firstAddress.address);
        server.getMainAddresses({}, function(err, addr) {
          should.not.exist(err);
          addr.length.should.equal(1);
          done();
        });
      });
    });

    it('should reuse address as change address on tx proposal creation', function(done) {
      helpers.stubUtxos(server, wallet, 2, function() {
        var address = '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU';
        var txOpts = {
          app: 'payment',
          params: {
            outputs: [{
              amount: 1e8,
              address: address,
            }],
          }
        };
        txOpts = helpers.composeJoint(txOpts);
        server.createTx(txOpts, function(err, txp) {
          should.not.exist(err);
          should.exist(txp);
          should.exist(txp.changeAddress);
          txp.changeAddress.should.equal(firstAddress.address);
          done();
        });
      });
    });

    it('should not duplicate address on storage after TX creation', function(done) {
      helpers.stubUtxos(server, wallet, 2, function() {
        var address = '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU';
        var txOpts = {
          app: 'payment',
          params: {
            outputs: [{
              amount: 1e8,
              address: address,
            }],
          }
        };
        txOpts = helpers.composeJoint(txOpts);
        server.createTx(txOpts, function(err, txp) {
          should.not.exist(err);
          server.storage.fetchAddresses(wallet.id, function(err, addresses) {
            should.not.exist(err);
            addresses.length.should.equal(1);
            done();
          });
        });
      });
    });

    it('should not be able to specify custom changeAddress', function(done) {
      helpers.stubUtxos(server, wallet, 2, function() {
        var address = '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU';
        var txOpts = {
          app: 'payment',
          params: {
            outputs: [{
              amount: 1e8,
              address: address,
            }],
            change_address: firstAddress.address,
          },
        };
        server.createTx(txOpts, function(err, txp) {
          should.exist(err);
          err.message.should.contain('single-address');
          done();
        });
      });
    });
  });

  describe('#rejectTx', function() {
    var server, wallet, txid;

    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 2, function(s, w) {
        server = s;
        wallet = w;
        helpers.stubUtxos(server, wallet, _.range(1, 9), function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 10e8,
              }],
            }
          };
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
            should.exist(tx);
            txid = tx.id;
            done();
          });
        });
      });
    });

    it('should reject a TX', function(done) {
      server.getPendingTxs({}, function(err, txs) {
        var tx = txs[0];
        tx.id.should.equal(txid);

        server.rejectTx({
          txProposalId: txid,
          reason: 'some reason',
        }, function(err) {
          should.not.exist(err);
          server.getPendingTxs({}, function(err, txs) {
            should.not.exist(err);
            txs.should.be.empty;
            server.getTx({
              txProposalId: txid
            }, function(err, tx) {
              var actors = tx.getActors();
              actors.length.should.equal(1);
              actors[0].should.equal(wallet.copayers[0].id);
              var action = tx.getActionByCopayer(wallet.copayers[0].id);
              action.type.should.equal('reject');
              action.comment.should.equal('some reason');
              done();
            });
          });
        });
      });
    });

    it('should fail to reject non-pending TX', function(done) {
      async.waterfall([

        function(next) {
          server.getPendingTxs({}, function(err, txs) {
            var tx = txs[0];
            tx.id.should.equal(txid);
            next();
          });
        },
        function(next) {
          server.rejectTx({
            txProposalId: txid,
            reason: 'some reason',
          }, function(err) {
            should.not.exist(err);
            next();
          });
        },
        function(next) {
          server.getPendingTxs({}, function(err, txs) {
            should.not.exist(err);
            txs.should.be.empty;
            next();
          });
        },
        function(next) {
          helpers.getAuthServer(wallet.copayers[1].id, function(server) {
            server.rejectTx({
              txProposalId: txid,
              reason: 'some other reason',
            }, function(err) {
              should.exist(err);
              err.code.should.equal('TX_NOT_PENDING');
              done();
            });
          });
        },
      ]);
    });
  });

  describe('#signTx', function() {
    describe('1-of-1 (BIP44 & NORMAL)', function() {
      var server, wallet, txid;

      beforeEach(function(done) {
        helpers.createAndJoinWallet(1, 1, function(s, w) {
          server = s;
          wallet = w;
          helpers.stubUtxos(server, wallet, [1, 2], function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 2.5e8,
                }],
              }
            };
            helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
              should.exist(tx);
              tx.addressType.should.equal('normal');
              txid = tx.id;
              done();
            });
          });
        });
      });

      it('should sign a TX with multiple inputs, different paths, and return raw', function(done) {
        blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, null);
        server.getPendingTxs({}, function(err, txs) {
          var tx = txs[0];
          tx.id.should.equal(txid);
          var signatures = helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
          server.signTx({
            txProposalId: txid,
            signatures: signatures,
          }, function(err, txp) {
            should.not.exist(err);
            txp.status.should.equal('accepted');

            // Get pending should also contains the raw TX
            server.getPendingTxs({}, function(err, txs) {
              var tx = txs[0];
              should.not.exist(err);
              tx.status.should.equal('accepted');
              done();
            });
          });
        });
      });
    });

    describe('Multisig', function() {
      var server, wallet, txid;

      beforeEach(function(done) {
        helpers.createAndJoinWallet(2, 3, function(s, w) {
          server = s;
          wallet = w;
          helpers.stubUtxos(server, wallet, _.range(1, 9), function() {
            var txOpts = {
              app: 'payment',
              params: {
                outputs: [{
                  address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                  amount: 20e8,
                }],
              }
            };
            helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(tx) {
              should.exist(tx);
              txid = tx.id;
              done();
            });
          });
        });
      });

      it('should sign a TX with multiple inputs, different paths', function(done) {
        server.getPendingTxs({}, function(err, txs) {
          var tx = txs[0];
          tx.id.should.equal(txid);
          var signatures = helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
          server.signTx({
            txProposalId: txid,
            signatures: signatures,
          }, function(err, txp) {
            should.not.exist(err);
            server.getPendingTxs({}, function(err, txs) {
              should.not.exist(err);
              var tx = txs[0];
              tx.id.should.equal(txid);

              var actors = tx.getActors();
              actors.length.should.equal(1);
              actors[0].should.equal(wallet.copayers[0].id);
              tx.getActionByCopayer(wallet.copayers[0].id).type.should.equal('accept');

              done();
            });
          });
        });
      });

      it('should fail to sign with a xpriv from other copayer', function(done) {
        server.getPendingTxs({}, function(err, txs) {
          var tx = txs[0];
          tx.id.should.equal(txid);
          var signatures = helpers.clientSign(tx, TestData.copayers[1].xPrivKey_44H_0H_0H, server.walletId);
          server.signTx({
            txProposalId: txid,
            signatures: signatures,
          }, function(err) {
            err.code.should.equal('BAD_SIGNATURES');
            done();
          });
        });
      });

      it('should fail if one signature is broken', function(done) {
        server.getPendingTxs({}, function(err, txs) {
          var tx = txs[0];
          tx.id.should.equal(txid);

          var signatures = helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
          signatures[0] = 1;

          server.signTx({
            txProposalId: txid,
            signatures: signatures,
          }, function(err) {
            err.message.should.contain('signatures');
            done();
          });
        });
      });

      it('should fail on invalid signature', function(done) {
        server.getPendingTxs({}, function(err, txs) {
          var tx = txs[0];
          tx.id.should.equal(txid);

          var signatures = ['11', '22', '33', '44', '55'];
          server.signTx({
            txProposalId: txid,
            signatures: signatures,
          }, function(err) {
            should.exist(err);
            err.message.should.contain('Bad signatures');
            done();
          });
        });
      });

      it('should fail on wrong number of invalid signatures', function(done) {
        server.getPendingTxs({}, function(err, txs) {
          var tx = txs[0];
          tx.id.should.equal(txid);

          var signatures = _.take(helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId), 1);
          server.signTx({
            txProposalId: txid,
            signatures: signatures,
          }, function(err) {
            should.exist(err);
            err.message.should.contain('Bad signatures');
            done();
          });
        });
      });

      it('should fail when signing a TX previously rejected', function(done) {
        server.getPendingTxs({}, function(err, txs) {
          var tx = txs[0];
          tx.id.should.equal(txid);

          var signatures = helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
          server.signTx({
            txProposalId: txid,
            signatures: signatures,
          }, function(err) {
            server.rejectTx({
              txProposalId: txid,
            }, function(err) {
              err.code.should.contain('COPAYER_VOTED');
              done();
            });
          });
        });
      });

      it('should fail when rejected a previously signed TX', function(done) {
        server.getPendingTxs({}, function(err, txs) {
          var tx = txs[0];
          tx.id.should.equal(txid);

          server.rejectTx({
            txProposalId: txid,
          }, function(err) {
            var signatures = helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
            server.signTx({
              txProposalId: txid,
              signatures: signatures,
            }, function(err) {
              err.code.should.contain('COPAYER_VOTED');
              done();
            });
          });
        });
      });

      it('should fail to sign a non-pending TX', function(done) {
        async.waterfall([

          function(next) {
            server.rejectTx({
              txProposalId: txid,
              reason: 'some reason',
            }, function(err) {
              should.not.exist(err);
              next();
            });
          },
          function(next) {
            helpers.getAuthServer(wallet.copayers[1].id, function(server) {
              server.rejectTx({
                txProposalId: txid,
                reason: 'some reason',
              }, function(err) {
                should.not.exist(err);
                next();
              });
            });
          },
          function(next) {
            server.getPendingTxs({}, function(err, txs) {
              should.not.exist(err);
              txs.should.be.empty;
              next();
            });
          },
          function(next) {
            helpers.getAuthServer(wallet.copayers[2].id, function(server) {
              server.getTx({
                txProposalId: txid
              }, function(err, tx) {
                should.not.exist(err);
                var signatures = helpers.clientSign(tx, TestData.copayers[2].xPrivKey_44H_0H_0H, server.walletId);
                server.signTx({
                  txProposalId: txid,
                  signatures: signatures,
                }, function(err) {
                  should.exist(err);
                  err.code.should.equal('TX_NOT_PENDING');
                  done();
                });
              });
            });
          },
        ]);
      });
    });
  });

  describe('#broadcastTx & #broadcastJoint', function() {
    var server, wallet, txpid, txid;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 1, function(s, w) {
        server = s;
        wallet = w;
        helpers.stubUtxos(server, wallet, [10, 10], function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 9e8,
              }],
            }
          };
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
            should.exist(txp);
            var signatures = helpers.clientSign(txp, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
            server.signTx({
              txProposalId: txp.id,
              signatures: signatures,
            }, function(err, txp) {
              should.not.exist(err);
              should.exist(txp);
              txp.isAccepted().should.be.true;
              txp.isBroadcasted().should.be.false;
              txid = txp.txid;
              txpid = txp.id;
              done();
            });
          });
        });
      });
    });

    it('should broadcast a tx', function(done) {
      var clock = sinon.useFakeTimers({now: 1234000, toFake: ['Date']});
      helpers.stubBroadcast();
      server.broadcastTx({
        txProposalId: txpid
      }, function(err) {
        should.not.exist(err);
        server.getTx({
          txProposalId: txpid
        }, function(err, txp) {
          should.not.exist(err);
          should.not.exist(txp.raw);
          txp.txid.should.equal(txid);
          txp.isBroadcasted().should.be.true;
          txp.broadcastedOn.should.equal(1234);
          clock.restore();
          done();
        });
      });
    });

    it('should broadcast a joint', function(done) {
      helpers.stubBroadcast();
      server.broadcastJoint({
        network: 'livenet',
        joint: 'joint',
      }, function(err, txid) {
        should.not.exist(err);
        done();
      });
    });

    it('should fail to brodcast a tx already marked as broadcasted', function(done) {
      helpers.stubBroadcast();
      server.broadcastTx({
        txProposalId: txpid
      }, function(err) {
        should.not.exist(err);
        server.broadcastTx({
          txProposalId: txpid
        }, function(err) {
          should.exist(err);
          err.code.should.equal('TX_ALREADY_BROADCASTED');
          done();
        });
      });
    });

    it('should auto process already broadcasted txs', function(done) {
      helpers.stubBroadcast();
      server.getPendingTxs({}, function(err, txs) {
        should.not.exist(err);
        txs.length.should.equal(1);
        blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, { txid: 999 });
        server.getPendingTxs({}, function(err, txs) {
          should.not.exist(err);
          txs.length.should.equal(0);
          done();
        });
      });
    });

    it('should process only broadcasted txs', function(done) {
      helpers.stubBroadcast();
      var txOpts = {
        app: 'payment',
        params: {
          outputs: [{
            address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
            amount: 9e8,
          }],
        }
      };
      helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
        server.getPendingTxs({}, function(err, txs) {
          should.not.exist(err);
          txs.length.should.equal(2);
          blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, { txid: 999 });
          server.getPendingTxs({}, function(err, txs) {
            should.not.exist(err);
            txs.length.should.equal(1);
            txs[0].status.should.equal('pending');
            should.not.exist(txs[0].txid);
            done();
          });
        });
      });
    });

    it('should fail to brodcast a not yet accepted tx', function(done) {
      helpers.stubBroadcast();
      var txOpts = {
        app: 'payment',
        params: {
          outputs: [{
            address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
            amount: 9e8,
          }],
        }
      };
      helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
        should.exist(txp);
        server.broadcastTx({
          txProposalId: txp.id
        }, function(err) {
          should.exist(err);
          err.code.should.equal('TX_NOT_ACCEPTED');
          done();
        });
      });
    });

    it('should keep tx as accepted if unable to broadcast it', function(done) {
      blockchainExplorer.broadcastJoint = sinon.stub().callsArgWith(1, 'broadcast error');
      blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, null);
      server.broadcastTx({
        txProposalId: txpid
      }, function(err) {
        should.exist(err);
        err.toString().should.equal('broadcast error');
        server.getTx({
          txProposalId: txpid
        }, function(err, txp) {
          should.not.exist(err);
          should.exist(txp.txid);
          txp.isBroadcasted().should.be.false;
          should.not.exist(txp.broadcastedOn);
          txp.isAccepted().should.be.true;
          done();
        });
      });
    });

    it('should mark tx as broadcasted if accepted but already in blockchain', function(done) {
      blockchainExplorer.broadcastJoint = sinon.stub().callsArgWith(1, null);
      blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, { txid: '999' });
      server.broadcastTx({
        txProposalId: txpid
      }, function(err) {
        should.not.exist(err);
        server.getTx({
          txProposalId: txpid
        }, function(err, txp) {
          should.not.exist(err);
          should.exist(txp.txid);
          txp.isBroadcasted().should.be.true;
          should.exist(txp.broadcastedOn);
          done();
        });
      });
    });

    it('should keep tx as accepted if broadcast fails and cannot check tx in blockchain', function(done) {
      blockchainExplorer.broadcastJoint = sinon.stub().callsArgWith(1, 'broadcast error');
      blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, null);
      server.broadcastTx({
        txProposalId: txpid
      }, function(err) {
        should.exist(err);
        err.toString().should.equal('broadcast error');
        server.getTx({
          txProposalId: txpid
        }, function(err, txp) {
          should.not.exist(err);
          should.exist(txp.txid);
          txp.isBroadcasted().should.be.false;
          should.not.exist(txp.broadcastedOn);
          txp.isAccepted().should.be.true;
          done();
        });
      });
    });
  });

  describe('Tx proposal workflow', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 3, function(s, w) {
        server = s;
        wallet = w;
        helpers.stubUtxos(server, wallet, _.range(1, 9), function() {
          helpers.stubBroadcast();
          done();
        });
      });
    });

    it('other copayers should see pending proposal created by one copayer', function(done) {
      var txOpts = {
        app: 'payment',
        params: {
          outputs: [{
            address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
            amount: 9e8,
          }],
        }
      };
      helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
        should.exist(txp);
        helpers.getAuthServer(wallet.copayers[1].id, function(server2, wallet) {
          server2.getPendingTxs({}, function(err, txps) {
            should.not.exist(err);
            txps.length.should.equal(1);
            txps[0].id.should.equal(txp.id);
            done();
          });
        });
      });
    });

    it('tx proposals should not be finally accepted until quorum is reached', function(done) {
      var txpId;
      async.waterfall([

        function(next) {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 9e8,
              }],
            }
          };
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
            txpId = txp.id;
            should.exist(txp);
            next();
          });
        },
        function(next) {
          server.getPendingTxs({}, function(err, txps) {
            should.not.exist(err);
            txps.length.should.equal(1);
            var txp = txps[0];
            txp.actions.should.be.empty;
            next(null, txp);
          });
        },
        function(txp, next) {
          var signatures = helpers.clientSign(txp, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
          server.signTx({
            txProposalId: txpId,
            signatures: signatures,
          }, function(err) {
            should.not.exist(err);
            next();
          });
        },
        function(next) {
          server.getPendingTxs({}, function(err, txps) {
            should.not.exist(err);
            txps.length.should.equal(1);
            var txp = txps[0];
            txp.isPending().should.be.true;
            txp.isAccepted().should.be.false;
            txp.isRejected().should.be.false;
            txp.isBroadcasted().should.be.false;
            txp.actions.length.should.equal(1);
            var action = txp.getActionByCopayer(wallet.copayers[0].id);
            action.type.should.equal('accept');
            server.getNotifications({}, function(err, notifications) {
              should.not.exist(err);
              var last = _.last(notifications);
              last.type.should.not.equal('TxProposalFinallyAccepted');
              next(null, txp);
            });
          });
        },
        function(txp, next) {
          helpers.getAuthServer(wallet.copayers[1].id, function(server, wallet) {
            var signatures = helpers.clientSign(txp, TestData.copayers[1].xPrivKey_44H_0H_0H, server.walletId);
            server.signTx({
              txProposalId: txpId,
              signatures: signatures,
            }, function(err) {
              should.not.exist(err);
              next();
            });
          });
        },
        function(next) {
          server.getPendingTxs({}, function(err, txps) {
            should.not.exist(err);
            txps.length.should.equal(1);
            var txp = txps[0];
            txp.isPending().should.be.true;
            txp.isAccepted().should.be.true;
            txp.isBroadcasted().should.be.false;
            should.exist(txp.txid);
            txp.actions.length.should.equal(2);
            server.getNotifications({}, function(err, notifications) {
              should.not.exist(err);
              var last = _.last(notifications);
              last.type.should.equal('TxProposalFinallyAccepted');
              last.walletId.should.equal(wallet.id);
              last.creatorId.should.equal(wallet.copayers[1].id);
              last.data.txProposalId.should.equal(txp.id);
              done();
            });
          });
        },
      ]);
    });

    it('tx proposals should accept as many rejections as possible without finally rejecting', function(done) {
      var txpId;
      async.waterfall([

        function(next) {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 9e8,
              }],
            }
          };
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
            txpId = txp.id;
            should.exist(txp);
            next();
          });
        },
        function(next) {
          server.getPendingTxs({}, function(err, txps) {
            should.not.exist(err);
            txps.length.should.equal(1);
            var txp = txps[0];
            txp.actions.should.be.empty;
            next();
          });
        },
        function(next) {
          server.rejectTx({
            txProposalId: txpId,
            reason: 'just because'
          }, function(err) {
            should.not.exist(err);
            next();
          });
        },
        function(next) {
          server.getPendingTxs({}, function(err, txps) {
            should.not.exist(err);
            txps.length.should.equal(1);
            var txp = txps[0];
            txp.isPending().should.be.true;
            txp.isRejected().should.be.false;
            txp.isAccepted().should.be.false;
            txp.actions.length.should.equal(1);
            var action = txp.getActionByCopayer(wallet.copayers[0].id);
            action.type.should.equal('reject');
            action.comment.should.equal('just because');
            next();
          });
        },
        function(next) {
          helpers.getAuthServer(wallet.copayers[1].id, function(server, wallet) {
            server.rejectTx({
              txProposalId: txpId,
              reason: 'some other reason'
            }, function(err) {
              should.not.exist(err);
              next();
            });
          });
        },
        function(next) {
          server.getPendingTxs({}, function(err, txps) {
            should.not.exist(err);
            txps.length.should.equal(0);
            next();
          });
        },
        function(next) {
          server.getTx({
            txProposalId: txpId
          }, function(err, txp) {
            should.not.exist(err);
            txp.isPending().should.be.false;
            txp.isRejected().should.be.true;
            txp.isAccepted().should.be.false;
            txp.actions.length.should.equal(2);
            done();
          });
        },
      ]);
    });
  });

  describe('#getTx', function() {
    var server, wallet, txpid;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 3, function(s, w) {
        server = s;
        wallet = w;
        helpers.stubUtxos(server, wallet, 1, function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 9e8,
              }],
            }
          };
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
            should.exist(txp);
            txpid = txp.id;
            done();
          });
        });
      });
    });

    it('should get own transaction proposal', function(done) {
      server.getTx({
        txProposalId: txpid
      }, function(err, txp) {
        should.not.exist(err);
        should.exist(txp);
        txp.id.should.equal(txpid);
        done();
      });
    });

    it('should get someone elses transaction proposal', function(done) {
      helpers.getAuthServer(wallet.copayers[1].id, function(server2, wallet) {
        server2.getTx({
          txProposalId: txpid
        }, function(err, res) {
          should.not.exist(err);
          res.id.should.equal(txpid);
          done();
        });
      });
    });

    it('should fail to get non-existent transaction proposal', function(done) {
      server.getTx({
        txProposalId: 'dummy'
      }, function(err, txp) {
        should.exist(err);
        should.not.exist(txp);
        err.code.should.equal('TX_NOT_FOUND')
        err.message.should.equal('Transaction proposal not found');
        done();
      });
    });
    it.skip('should get accepted/rejected transaction proposal', function(done) {});
    it.skip('should get broadcasted transaction proposal', function(done) {});
  });

  describe('#getTxs', function() {
    var server, wallet, clock;

    beforeEach(function(done) {
      this.timeout(5000);
      clock = sinon.useFakeTimers({toFake: ['Date']});
      helpers.createAndJoinWallet(1, 1, function(s, w) {
        server = s;
        wallet = w;
        helpers.stubUtxos(server, wallet, _.range(1, 11), function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 9e8,
              }],
            }
          };
          async.eachSeries(_.range(10), function(i, next) {
            clock.tick(10 * 1000);
            helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
              next();
            });
          }, function(err) {
            clock.restore();
            return done(err);
          });
        });
      });
    });

    afterEach(function() {
 //     clock.restore();
    });

    it('should pull 4 txs, down to to time 60', function(done) {
      server.getTxs({
        minTs: 60,
        limit: 8
      }, function(err, txps) {
        should.not.exist(err);
        var times = _.map(txps, 'createdOn');
        times.should.deep.equal([100, 90, 80, 70, 60]);
        done();
      });
    });

    it('should pull the first 5 txs', function(done) {
      server.getTxs({
        maxTs: 50,
        limit: 5
      }, function(err, txps) {
        should.not.exist(err);
        var times = _.map(txps, 'createdOn');
        times.should.deep.equal([50, 40, 30, 20, 10]);
        done();
      });
    });

    it('should pull the last 4 txs', function(done) {
      server.getTxs({
        limit: 4
      }, function(err, txps) {
        should.not.exist(err);
        var times = _.map(txps, 'createdOn');
        times.should.deep.equal([100, 90, 80, 70]);
        done();
      });
    });

    it('should pull all txs', function(done) {
      server.getTxs({}, function(err, txps) {
        should.not.exist(err);
        var times = _.map(txps, 'createdOn');
        times.should.deep.equal([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
        done();
      });
    });

    it('should txs from times 50 to 70',
      function(done) {
        server.getTxs({
          minTs: 50,
          maxTs: 70,
        }, function(err, txps) {
          should.not.exist(err);
          var times = _.map(txps, 'createdOn');
          times.should.deep.equal([70, 60, 50]);
          done();
        });
      });
  });

  describe('#getNotifications', function() {
    var clock;
    var server, wallet;

    beforeEach(function(done) {
      clock = sinon.useFakeTimers({now: 10*1000, toFake: ['Date']});
      helpers.createAndJoinWallet(1, 1, function(s, w) {
        server = s;
        wallet = w;
        helpers.stubUtxos(server, wallet, _.range(4), function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 9e8,
              }],
            }
          };
          async.eachSeries(_.range(3), function(i, next) {
            clock.tick(25 * 1000);
            helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
              next();
            });
          }, function(err) {
            clock.tick(20 * 1000);
            return done(err);
          });
        });
      });
    });

    afterEach(function() {
      clock.restore();
    });

    it('should pull all notifications', function(done) {
      server.getNotifications({}, function(err, notifications) {
        should.not.exist(err);
        var types = _.map(notifications, 'type');
        types.should.deep.equal(['NewCopayer', 'NewAddress', 'NewAddress', 'NewTxProposal', 'NewTxProposal', 'NewTxProposal']);
        var walletIds = _.uniq(_.map(notifications, 'walletId'));
        walletIds.length.should.equal(1);
        walletIds[0].should.equal(wallet.id);
        var creators = _.uniq(_.compact(_.map(notifications, 'creatorId')));
        creators.length.should.equal(1);
        creators[0].should.equal(wallet.copayers[0].id);
        done();
      });
    });

    it('should pull new payment notifications with correct format', function(done) {
      var s2, w2, addr;
      helpers.createAndJoinWallet(1, 1, {offset: 1}, function(s, w) {
        s2 = s;
        w2 = w;
        helpers.createAddresses(s2, w2, 1, 1, function(main, change) {
          addr = main[0].address;
          // Simulate new block notification
          s2.walletId = w2.id;
          s2._notify('NewIncomingTx', {
            txid: 'txid',
            address: addr,
            amount: 5435,
            hash: 'dummy hash',
          }, {
            isGlobal: true
          }, function(err) {
            should.not.exist(err);
            s2.getNotifications({
              minTs: +Date.now() - (60 * 1000),
            }, function(err, notifications) {
              should.not.exist(err);
              var types = _.map(notifications, 'type');
              types.should.deep.equal(['NewCopayer', 'NewIncomingTx']);
              var walletIds = _.uniq(_.map(notifications, 'walletId'));
              walletIds.length.should.equal(1);
              walletIds[0].should.equal(w2.id);
              done();
            });
          });
        });
      });
    });

    it('should pull notifications in the last 60 seconds', function(done) {
      server.getNotifications({
        minTs: +Date.now() - (60 * 1000),
      }, function(err, notifications) {
        should.not.exist(err);
        var types = _.map(notifications, 'type');
        types.should.deep.equal(['NewTxProposal', 'NewTxProposal']);
        done();
      });
    });

    it('should pull notifications after a given notification id', function(done) {
      server.getNotifications({}, function(err, notifications) {
        should.not.exist(err);
        var from = _.head(_.takeRight(notifications, 2)).id; // second to last
        server.getNotifications({
          notificationId: from,
          minTs: +Date.now() - (60 * 1000),
        }, function(err, res) {
          should.not.exist(err);
          res.length.should.equal(1);
          res[0].id.should.equal(_.head(_.takeRight(notifications)).id);
          done();
        });
      });
    });

    it('should return empty if no notifications found after a given id', function(done) {
      server.getNotifications({}, function(err, notifications) {
        should.not.exist(err);
        var from = _.head(_.takeRight(notifications)).id; // last one
        server.getNotifications({
          notificationId: from,
        }, function(err, res) {
          should.not.exist(err);
          res.length.should.equal(0);
          done();
        });
      });
    });

    it('should return empty if no notifications exist in the given timespan', function(done) {
      clock.tick(100 * 1000);
      server.getNotifications({
        minTs: +Date.now() - (60 * 1000),
      }, function(err, res) {
        should.not.exist(err);
        res.length.should.equal(0);
        done();
      });
    });

    it('should contain walletId & creatorId on NewCopayer', function(done) {
      server.getNotifications({}, function(err, notifications) {
        should.not.exist(err);
        var newCopayer = notifications[0];
        newCopayer.type.should.equal('NewCopayer');
        newCopayer.walletId.should.equal(wallet.id);
        newCopayer.creatorId.should.equal(wallet.copayers[0].id);
        done();
      });
    });

    it('should notify sign and acceptance', function(done) {
      server.getPendingTxs({}, function(err, txs) {
        blockchainExplorer.broadcastJoint = sinon.stub().callsArgWith(1, 'broadcast error');
        var tx = txs[0];
        var signatures = helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
        server.signTx({
          txProposalId: tx.id,
          signatures: signatures,
        }, function(err) {
          server.getNotifications({
            minTs: Date.now(),
          }, function(err, notifications) {
            should.not.exist(err);
            notifications.length.should.equal(2);
            var types = _.map(notifications, 'type');
            types.should.deep.equal(['TxProposalAcceptedBy', 'TxProposalFinallyAccepted']);
            done();
          });
        });
      });
    });

    it('should notify rejection', function(done) {
      server.getPendingTxs({}, function(err, txs) {
        var tx = txs[1];
        server.rejectTx({
          txProposalId: tx.id,
        }, function(err) {
          should.not.exist(err);
          server.getNotifications({
            minTs: Date.now(),
          }, function(err, notifications) {
            should.not.exist(err);
            notifications.length.should.equal(2);
            var types = _.map(notifications, 'type');
            types.should.deep.equal(['TxProposalRejectedBy', 'TxProposalFinallyRejected']);
            done();
          });
        });
      });
    });

    it('should notify sign, acceptance, and broadcast, and emit', function(done) {
      server.getPendingTxs({}, function(err, txs) {
        var tx = txs[2];
        var signatures = helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
        server.signTx({
          txProposalId: tx.id,
          signatures: signatures,
        }, function(err) {
          should.not.exist(err);
          helpers.stubBroadcast();
          server.broadcastTx({
            txProposalId: tx.id
          }, function(err, txp) {
            should.not.exist(err);
            server.getNotifications({
              minTs: Date.now(),
            }, function(err, notifications) {
              should.not.exist(err);
              notifications.length.should.equal(3);
              var types = _.map(notifications, 'type');
              types.should.deep.equal(['TxProposalAcceptedBy', 'TxProposalFinallyAccepted', 'NewOutgoingTx']);
              done();
            });
          });
        });
      });
    });

    it('should notify sign, acceptance, and broadcast, and emit (with 3rd party broadcast)', function(done) {
      server.getPendingTxs({}, function(err, txs) {
        var tx = txs[2];
        var signatures = helpers.clientSign(tx, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
        server.signTx({
          txProposalId: tx.id,
          signatures: signatures,
        }, function(err) {
          should.not.exist(err);
          blockchainExplorer.broadcastJoint = sinon.stub().callsArgWith(1, 'broadcast err');
          blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, { txid: 11 });
          server.broadcastTx({
            txProposalId: tx.id
          }, function(err, txp) {
            should.not.exist(err);
            server.getNotifications({
              minTs: Date.now(),
            }, function(err, notifications) {
              should.not.exist(err);
              notifications.length.should.equal(3);
              var types = _.map(notifications, 'type');
              types.should.deep.equal(['TxProposalAcceptedBy', 'TxProposalFinallyAccepted', 'NewOutgoingTxByThirdParty']);
              done();
            });
          });
        });
      });
    });
  });

  describe('#removePendingTx', function() {
    var server, wallet, txp;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 3, function(s, w) {
        server = s;
        wallet = w;
        helpers.stubUtxos(server, wallet, [1, 2], function() {
          var txOpts = {
            app: 'payment',
            params: {
              outputs: [{
                address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
                amount: 9e8,
              }],
            }
          };
          helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function() {
            server.getPendingTxs({}, function(err, txs) {
              txp = txs[0];
              done();
            });
          });
        });
      });
    });

    it('should allow creator to remove an unsigned TX', function(done) {
      server.removePendingTx({
        txProposalId: txp.id
      }, function(err) {
        should.not.exist(err);
        server.getPendingTxs({}, function(err, txs) {
          txs.length.should.equal(0);
          done();
        });
      });
    });

    it('should allow creator to remove a signed TX by himself', function(done) {
      var signatures = helpers.clientSign(txp, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
      server.signTx({
        txProposalId: txp.id,
        signatures: signatures,
      }, function(err) {
        should.not.exist(err);
        server.removePendingTx({
          txProposalId: txp.id
        }, function(err) {
          should.not.exist(err);
          server.getPendingTxs({}, function(err, txs) {
            txs.length.should.equal(0);
            done();
          });
        });
      });
    });

    it('should fail to remove non-pending TX', function(done) {
      async.waterfall([
        function(next) {
          var signatures = helpers.clientSign(txp, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
          server.signTx({
            txProposalId: txp.id,
            signatures: signatures,
          }, function(err) {
            should.not.exist(err);
            next();
          });
        },
        function(next) {
          helpers.getAuthServer(wallet.copayers[1].id, function(server) {
            server.rejectTx({
              txProposalId: txp.id,
            }, function(err) {
              should.not.exist(err);
              next();
            });
          });
        },
        function(next) {
          helpers.getAuthServer(wallet.copayers[2].id, function(server) {
            server.rejectTx({
              txProposalId: txp.id,
            }, function(err) {
              should.not.exist(err);
              next();
            });
          });
        },
        function(next) {
          server.getPendingTxs({}, function(err, txs) {
            should.not.exist(err);
            txs.should.be.empty;
            next();
          });
        },
        function(next) {
          server.removePendingTx({
            txProposalId: txp.id
          }, function(err) {
            should.exist(err);
            err.code.should.equal('TX_NOT_PENDING');
            done();
          });
        },
      ]);
    });

    it('should not allow non-creator copayer to remove an unsigned TX ', function(done) {
      helpers.getAuthServer(wallet.copayers[1].id, function(server2) {
        server2.removePendingTx({
          txProposalId: txp.id
        }, function(err) {
          should.exist(err);
          err.code.should.contain('TX_CANNOT_REMOVE');
          server2.getPendingTxs({}, function(err, txs) {
            txs.length.should.equal(1);
            done();
          });
        });
      });
    });

    it('should not allow creator copayer to remove a TX signed by other copayer, in less than 24hrs', function(done) {
      helpers.getAuthServer(wallet.copayers[1].id, function(server2) {
        var signatures = helpers.clientSign(txp, TestData.copayers[1].xPrivKey_44H_0H_0H, server.walletId);
        server2.signTx({
          txProposalId: txp.id,
          signatures: signatures,
        }, function(err) {
          should.not.exist(err);
          server.removePendingTx({
            txProposalId: txp.id
          }, function(err) {
            err.code.should.equal('TX_CANNOT_REMOVE');
            err.message.should.contain('Cannot remove');
            done();
          });
        });
      });
    });

    it('should allow creator copayer to remove a TX rejected by other copayer, in less than 24hrs', function(done) {
      helpers.getAuthServer(wallet.copayers[1].id, function(server2) {
        var signatures = helpers.clientSign(txp, TestData.copayers[1].xPrivKey_44H_0H_0H, server.walletId);
        server2.rejectTx({
          txProposalId: txp.id,
          signatures: signatures,
        }, function(err) {
          should.not.exist(err);
          server.removePendingTx({
            txProposalId: txp.id
          }, function(err) {
            should.not.exist(err);
            done();
          });
        });
      });
    });

    it('should allow creator copayer to remove a TX signed by other copayer, after 24hrs', function(done) {
      helpers.getAuthServer(wallet.copayers[1].id, function(server2) {
        var signatures = helpers.clientSign(txp, TestData.copayers[1].xPrivKey_44H_0H_0H, server.walletId);
        server2.signTx({
          txProposalId: txp.id,
          signatures: signatures,
        }, function(err) {
          should.not.exist(err);

          server.getPendingTxs({}, function(err, txs) {
            should.not.exist(err);
            txs[0].deleteLockTime.should.be.above(Defaults.DELETE_LOCKTIME - 10);

            var clock = sinon.useFakeTimers({now: Date.now() + 1 + 24 * 3600 * 1000, toFake: ['Date']});
            server.removePendingTx({
              txProposalId: txp.id
            }, function(err) {
              should.not.exist(err);
              clock.restore();
              done();
            });
          });
        });
      });
    });

    it('should allow other copayer to remove a TX signed, after 24hrs', function(done) {
      helpers.getAuthServer(wallet.copayers[1].id, function(server2) {
        var signatures = helpers.clientSign(txp, TestData.copayers[1].xPrivKey_44H_0H_0H, server.walletId);
        server2.signTx({
          txProposalId: txp.id,
          signatures: signatures,
        }, function(err) {
          should.not.exist(err);

          var clock = sinon.useFakeTimers({now: Date.now() + 2000 + Defaults.DELETE_LOCKTIME * 1000, toFake: ['Date']});
          server2.removePendingTx({
            txProposalId: txp.id
          }, function(err) {
            should.not.exist(err);
            clock.restore();
            done();
          });
        });
      });
    });
  });

  describe('#scan', function() {
    var server, wallet;

    describe('1-of-1 wallet (BIP44 & NORMAL)', function() {
      beforeEach(function(done) {
        this.timeout(5000);
        Defaults.SCAN_ADDRESS_GAP = 2;

        helpers.createAndJoinWallet(1, 1, function(s, w) {
          server = s;
          wallet = w;
          done();
        });
      });

      afterEach(function() {});

      it('should scan main addresses', function(done) {
        helpers.stubAddressActivity(
          [
            '6HR2V2D64WA3VLM2BRIJGBTTMSMNKMEH', // m/0/0
            'W2AEJJ2WJM3QUGECBOOTGYOPC5HM4KXV', // m/0/2
            'ULKWGPJ3FNDO4Q43QRIVOKEEYKZRNMIA', // m/1/0
          ]);
        var expectedPaths = [
          'm/0/0',
          'm/0/1',
          'm/0/2',
          'm/1/0',
        ];
        server.scan({}, function(err) {
          should.not.exist(err);
          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.scanStatus.should.equal('success');
            server.storage.fetchAddresses(wallet.id, function(err, addresses) {
              should.exist(addresses);
              addresses.length.should.equal(expectedPaths.length);
              var paths = _.map(addresses, 'path');
              _.difference(paths, expectedPaths).length.should.equal(0);
              server.createAddress({}, function(err, address) {
                should.not.exist(err);
                address.path.should.equal('m/0/3');
                done();
              });
            });
          });
        });
      });

      it('should not go beyond max gap', function(done) {
        helpers.stubAddressActivity(
          [
            '6HR2V2D64WA3VLM2BRIJGBTTMSMNKMEH', // m/0/0
            'W2AEJJ2WJM3QUGECBOOTGYOPC5HM4KXV', // m/0/2
            '7AMIULLBHRBYDBPOI6BCWGFDTBJGU2DO', // m/0/5
            'RGT6TRBAFQ7HKDX265LB23NHZL7SMIHP', // m/1/3
          ]);
        var expectedPaths = [
          'm/0/0',
          'm/0/1',
          'm/0/2',
        ];
        server.scan({}, function(err) {
          should.not.exist(err);
          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.scanStatus.should.equal('success');
            server.storage.fetchAddresses(wallet.id, function(err, addresses) {
              should.exist(addresses);
              addresses.length.should.equal(expectedPaths.length);
              var paths = _.map(addresses, 'path');
              _.difference(paths, expectedPaths).length.should.equal(0);
              server.createAddress({}, function(err, address) {
                should.not.exist(err);
                address.path.should.equal('m/0/3');
                // A rescan should see the m/0/5 address initially beyond the gap
                server.scan({}, function(err) {
                  server.createAddress({}, function(err, address) {
                    should.not.exist(err);
                    address.path.should.equal('m/0/6');
                    done();
                  });
                });
              });
            });
          });
        });
      });

      it('should not affect indexes on new wallet', function(done) {
        helpers.stubAddressActivity([]);
        server.scan({}, function(err) {
          should.not.exist(err);
          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.scanStatus.should.equal('success');
            server.storage.fetchAddresses(wallet.id, function(err, addresses) {
              should.not.exist(err);
              addresses.length.should.equal(0);
              server.createAddress({}, function(err, address) {
                should.not.exist(err);
                address.path.should.equal('m/0/0');
                done();
              });
            });
          });
        });
      });

      it('should not rewind already generated addresses on error', function(done) {
        server.createAddress({}, function(err, address) {
          should.not.exist(err);
          address.path.should.equal('m/0/0');
          blockchainExplorer.getAddressActivity = sinon.stub().callsArgWith(1, 'dummy error');
          server.scan({}, function(err) {
            should.exist(err);
            err.toString().should.equal('dummy error');
            server.getWallet({}, function(err, wallet) {
              should.not.exist(err);
              wallet.scanStatus.should.equal('error');
              wallet.addressManager.receiveAddressIndex.should.equal(1);
              wallet.addressManager.changeAddressIndex.should.equal(0);
              server.createAddress({}, function(err, address) {
                should.exist(err);
                err.code.should.equal('WALLET_NEED_SCAN');
                done();
              });
            });
          });
        });
      });

      it('should abort scan if there is an error checking address activity', function(done) {
        blockchainExplorer.getAddressActivity = sinon.stub().callsArgWith(1, 'dummy error');
        server.scan({}, function(err) {
          should.exist(err);
          err.toString().should.equal('dummy error');
          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.scanStatus.should.equal('error');
            wallet.addressManager.receiveAddressIndex.should.equal(0);
            wallet.addressManager.changeAddressIndex.should.equal(0);
            server.storage.fetchAddresses(wallet.id, function(err, addresses) {
              should.not.exist(err);
              addresses.should.be.empty;
              server.getStatus({}, function(err, status) {
                should.exist(err);
                err.code.should.equal('WALLET_NEED_SCAN');
                done();
              });
            });
          });
        });
      });

      it.skip('index cache: should use cache, if previous scan failed', function(done) {
        helpers.stubAddressActivity(
          [
            '6HR2V2D64WA3VLM2BRIJGBTTMSMNKMEH', // m/0/0
            'W2AEJJ2WJM3QUGECBOOTGYOPC5HM4KXV', // m/0/2
            'ULKWGPJ3FNDO4Q43QRIVOKEEYKZRNMIA', // m/1/0
          ], 4);

        // First without activity
        var addr = 'JY6YVHW6NDOSUS23QFRVLYHRYB5CRLN3'; // m/0/3

        server.scan({ startingStep: 1 }, function(err) {
          should.exist('failed on request');

          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);

            // Because it failed
            wallet.addressManager.receiveAddressIndex.should.equal(0);
            wallet.addressManager.changeAddressIndex.should.equal(0);

            helpers.stubAddressActivity(
              [
                '6HR2V2D64WA3VLM2BRIJGBTTMSMNKMEH', // m/0/0
                'W2AEJJ2WJM3QUGECBOOTGYOPC5HM4KXV', // m/0/2
                'ULKWGPJ3FNDO4Q43QRIVOKEEYKZRNMIA', // m/1/0
              ], -1);
            var getAddressActivitySpy = sinon.spy(blockchainExplorer, 'getAddressActivity');

            server.scan( { startingStep:1 }, function(err) {
              should.not.exist(err);

              // should prederive 3 address, so 
              // First call should be m/0/3
              var calls = getAddressActivitySpy.getCalls();
              calls[0].args[0].should.equal(addr);

              server.storage.fetchAddresses(wallet.id, function(err, addresses) {
                should.exist(addresses);
                server.createAddress({}, function(err, address) {
                  should.not.exist(err);
                  address.path.should.equal('m/0/3');
                  done();
                });
              });
            });
          });
        });
      });

      it.skip('index cache: should not use cache, if scan worked ok', function(done) {
        helpers.stubAddressActivity(
          [
            '6HR2V2D64WA3VLM2BRIJGBTTMSMNKMEH', // m/0/0
            'W2AEJJ2WJM3QUGECBOOTGYOPC5HM4KXV', // m/0/2
            'ULKWGPJ3FNDO4Q43QRIVOKEEYKZRNMIA', // m/1/0
          ]);

        // First without activity
        var addr = 'JY6YVHW6NDOSUS23QFRVLYHRYB5CRLN3'; // m/0/3

        server.scan({ start}, function(err) {
          should.not.exist(err);

          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.addressManager.receiveAddressIndex.should.equal(3);
            wallet.addressManager.changeAddressIndex.should.equal(1);

            var getAddressActivitySpy = sinon.spy(blockchainExplorer, 'getAddressActivity');

            server.scan({}, function(err) {
              should.not.exist(err);

              var calls = getAddressActivitySpy.getCalls();
              calls[0].args[0].should.equal(addr);
              server.storage.fetchAddresses(wallet.id, function(err, addresses) {
                should.exist(addresses);
                server.createAddress({}, function(err, address) {
                  should.not.exist(err);
                  address.path.should.equal('m/0/3');
                  done();
                });
              });
            });
          });
        });
      });

      it('powerScan: should add not add skipped addresses if there is no activity', function(done) {
        Defaults.SCAN_ADDRESS_GAP = 5;
        helpers.stubAddressActivity(
          [
            '6HR2V2D64WA3VLM2BRIJGBTTMSMNKMEH', // m/0/0
            'W2AEJJ2WJM3QUGECBOOTGYOPC5HM4KXV', // m/0/2
            'ULKWGPJ3FNDO4Q43QRIVOKEEYKZRNMIA', // m/1/0
          ]);

        // First without activity
        var addr = 'JY6YVHW6NDOSUS23QFRVLYHRYB5CRLN3'; // m/0/3

        server.scan({ startingStep: 1000 }, function(err) {
          should.not.exist(err);
          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.addressManager.receiveAddressIndex.should.equal(3);
            wallet.addressManager.changeAddressIndex.should.equal(1);
            server.getMainAddresses({}, function(err, addr) {
              should.not.exist(err);
              addr.length.should.equal(3);
              done();
            });
          });
        });
      });

      it('powerScan: should add skipped addresses', function(done) {
        Defaults.SCAN_ADDRESS_GAP = 5;
        this.timeout(10000);
        helpers.stubAddressActivity(
          [
            '6HR2V2D64WA3VLM2BRIJGBTTMSMNKMEH', // m/0/0
            'W2AEJJ2WJM3QUGECBOOTGYOPC5HM4KXV', // m/0/2
            'TVNMXMTEQGWOYVBGHVWOER6ZXDPJ63KP', //m/0/99
            '27DQBJWGR7ACZAHVJF5IEINJVNWOPQNN', //m/0/199
            'KHNALNZOCYPB2I4ZHV667HGLMKUAV7F4', //m/0/200
            'ULKWGPJ3FNDO4Q43QRIVOKEEYKZRNMIA', // m/1/0
            '4KTXWB2I6JQTGR5SRGZXFZ6LPMLKJ3WQ', //m/1/9
          ]);

        // First without activity
        var addr = 'JY6YVHW6NDOSUS23QFRVLYHRYB5CRLN3'; // m/0/3

        server.scan({ startingStep: 1000 }, function(err) {
          should.not.exist(err);
          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.addressManager.receiveAddressIndex.should.equal(201);
            wallet.addressManager.changeAddressIndex.should.equal(10);
            server.getMainAddresses({}, function(err, addr) {
              should.not.exist(err);

              //201 MAIN addresses (0 to 200)
              addr.length.should.equal(201);
              done();
            });
          });
        });
      });
    });

    describe('shared wallet (BIP45)', function() {

      beforeEach(function(done) {
        this.timeout(5000);
        Defaults.SCAN_ADDRESS_GAP = 2;

        helpers.createAndJoinWallet(1, 2, {
          supportBIP44: false
        }, function(s, w) {
          server = s;
          wallet = w;
          done();
        });
      });
      afterEach(function() {});

      it('should scan main addresses', function(done) {
        helpers.stubAddressActivity(
          [
            'XV5U5UNVDGI2ZFQSIOYUI77MRSAFS2BX', // m/2147483647/0/0
            'WULE7Y3LU6OYEG5X6ZD27VDOV6A7FQZ5', // m/2147483647/0/2
            '4NFIWYOWJAZ7ELULSL6GZM2Y5FTWSAFW', // m/2147483647/1/0
          ]);
        var expectedPaths = [
          'm/2147483647/0/0',
          'm/2147483647/0/1',
          'm/2147483647/0/2',
          'm/2147483647/1/0',
        ];
        server.scan({}, function(err) {
          should.not.exist(err);
          server.getWallet({}, function(err, wallet) {
            should.not.exist(err);
            wallet.scanStatus.should.equal('success');
            server.storage.fetchAddresses(wallet.id, function(err, addresses) {
              should.exist(addresses);
              addresses.length.should.equal(expectedPaths.length);
              var paths = _.map(addresses, 'path');
              _.difference(paths, expectedPaths).length.should.equal(0);
              server.createAddress({}, function(err, address) {
                should.not.exist(err);
                address.path.should.equal('m/2147483647/0/3');
                done();
              });
            });
          });
        });
      });
      it('should scan main addresses & copayer addresses', function(done) {
        helpers.stubAddressActivity(
          [
            'XV5U5UNVDGI2ZFQSIOYUI77MRSAFS2BX', // m/2147483647/0/0
            '4NFIWYOWJAZ7ELULSL6GZM2Y5FTWSAFW', // m/2147483647/1/0
            'HN6HMXKNGATUSYO7PM5FGW6PJOSTV4XB', // m/0/0/1
            'H2ORYGHDIVKH25HKYT5KMJGI6GNIVKRS', // m/1/1/0
            'NHFP6KWL2NENGT7JSGCCOAPBVC7DHL4S', // m/1/0/0
          ]);
        var expectedPaths = [
          'm/2147483647/0/0',
          'm/2147483647/1/0',
          'm/0/0/0',
          'm/0/0/1',
          'm/1/0/0',
          'm/1/1/0',
        ];
        server.scan({
          includeCopayerBranches: true
        }, function(err) {
          should.not.exist(err);
          server.storage.fetchAddresses(wallet.id, function(err, addresses) {
            should.exist(addresses);
            addresses.length.should.equal(expectedPaths.length);
            var paths = _.map(addresses, 'path');
            _.difference(paths, expectedPaths).length.should.equal(0);
            done();
          })
        });
      });
    });
  });

  describe('#startScan', function() {
    var server, wallet;
    beforeEach(function(done) {
      this.timeout(5000);
      Defaults.SCAN_ADDRESS_GAP = 2;

      helpers.createAndJoinWallet(1, 1, {
        supportBIP44: false
      }, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });
    afterEach(function() {
      server.messageBroker.removeAllListeners();
    });

    it('should start an asynchronous scan', function(done) {
      helpers.stubAddressActivity(
        [
          'FRLJAD2744BLSRJYBWG2LD55BNDJNOHV', // m/2147483647/0/0
          'UEUUD267UXVXYEB6JTEUWFHZQDKA2GP7', // m/2147483647/0/2
          'IBQTSYSTF3OJVQBPIF5DVHA6GZYU7K2S', // m/2147483647/1/0
        ]);
      var expectedPaths = [
        'm/2147483647/0/0',
        'm/2147483647/0/1',
        'm/2147483647/0/2',
        'm/2147483647/1/0',
      ];
      server.messageBroker.onMessage(function(n) {
        if (n.type == 'ScanFinished') {
          server.getWallet({}, function(err, wallet) {
            should.exist(wallet.scanStatus);
            wallet.scanStatus.should.equal('success');
            should.not.exist(n.creatorId);
            server.storage.fetchAddresses(wallet.id, function(err, addresses) {
              should.exist(addresses);
              addresses.length.should.equal(expectedPaths.length);
              var paths = _.map(addresses, 'path');
              _.difference(paths, expectedPaths).length.should.equal(0);
              server.createAddress({}, function(err, address) {
                should.not.exist(err);
                address.path.should.equal('m/2147483647/0/3');
                done();
              });
            })
          });
        }
      });
      server.startScan({}, function(err) {
        should.not.exist(err);
      });
    });

    it('should set scan status error when unable to reach blockchain', function(done) {
      blockchainExplorer.getAddressActivity = sinon.stub().yields('dummy error');
      server.messageBroker.onMessage(function(n) {
        if (n.type == 'ScanFinished') {
          should.exist(n.data.error);
          server.getWallet({}, function(err, wallet) {
            should.exist(wallet.scanStatus);
            wallet.scanStatus.should.equal('error');
            done();
          });
        }
      });
      server.startScan({}, function(err) {
        should.not.exist(err);
      });
    });

    it('should start multiple asynchronous scans for different wallets', function(done) {
      helpers.stubAddressActivity([]);
      Defaults.SCAN_ADDRESS_GAP = 1;

      var scans = 0;
      server.messageBroker.onMessage(function(n) {
        if (n.type == 'ScanFinished') {
          scans++;
          if (scans == 2) done();
        }
      });

      // Create a second wallet
      var server2 = new WalletService();
      var opts = {
        name: 'second wallet',
        m: 1,
        n: 1,
        pubKey: TestData.keyPair.pub,
      };
      server2.createWallet(opts, function(err, walletId) {
        should.not.exist(err);
        var dxpri = Bitcore.HDPrivateKey(TestData.copayers[3].xPrivKey_1H);
        var copayerOpts = helpers.getSignedCopayerOpts({
          walletId: walletId,
          name: 'copayer 1',
          xPubKey: TestData.copayers[3].xPubKey_45H,
          requestPubKey: TestData.copayers[3].pubKey_1H_0,
          devicePubKey: dxpri.privateKey.toPublicKey(),
          account: 0
        });
        server.joinWallet(copayerOpts, function(err, result) {
          should.not.exist(err);
          helpers.getAuthServer(result.copayerId, function(server2) {
            server.startScan({}, function(err) {
              should.not.exist(err);
              scans.should.equal(0);
            });
            server2.startScan({}, function(err) {
              should.not.exist(err);
              scans.should.equal(0);
            });
            scans.should.equal(0);
          });
        });
      });
    });
  });

  describe('Push notifications', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 3, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should subscribe copayer to push notifications service', function(done) {
      helpers.getAuthServer(wallet.copayers[0].id, function(server) {
        should.exist(server);
        server.pushNotificationsSubscribe({
          token: 'DEVICE_TOKEN',
          packageName: 'com.wallet',
          platform: 'Android',
        }, function(err) {
          should.not.exist(err);
          server.storage.fetchPushNotificationSubs(wallet.copayers[0].id, function(err, subs) {
            should.not.exist(err);
            should.exist(subs);
            subs.length.should.equal(1);
            var s = subs[0];
            s.token.should.equal('DEVICE_TOKEN');
            s.packageName.should.equal('com.wallet');
            s.platform.should.equal('Android')
            done();
          });
        });
      });
    });

    it('should allow multiple subscriptions for the same copayer', function(done) {
      helpers.getAuthServer(wallet.copayers[0].id, function(server) {
        should.exist(server);
        server.pushNotificationsSubscribe({
          token: 'DEVICE_TOKEN',
          packageName: 'com.wallet',
          platform: 'Android',
        }, function(err) {
          server.pushNotificationsSubscribe({
            token: 'DEVICE_TOKEN2',
            packageName: 'com.my-other-wallet',
            platform: 'iOS',
          }, function(err) {
            should.not.exist(err);
            server.storage.fetchPushNotificationSubs(wallet.copayers[0].id, function(err, subs) {
              should.not.exist(err);
              should.exist(subs);
              subs.length.should.equal(2);
              done();
            });
          });
        });
      });
    });

    it('should unsubscribe copayer to push notifications service', function(done) {
      helpers.getAuthServer(wallet.copayers[0].id, function(server) {
        should.exist(server);
        async.series([

          function(next) {
            server.pushNotificationsSubscribe({
              token: 'DEVICE_TOKEN',
              packageName: 'com.wallet',
              platform: 'Android',
            }, next);
          },
          function(next) {
            server.pushNotificationsSubscribe({
              token: 'DEVICE_TOKEN2',
              packageName: 'com.my-other-wallet',
              platform: 'iOS',
            }, next);
          },
          function(next) {
            server.pushNotificationsUnsubscribe({
              token: 'DEVICE_TOKEN2'
            }, next);
          },
          function(next) {
            server.storage.fetchPushNotificationSubs(wallet.copayers[0].id, function(err, subs) {
              should.not.exist(err);
              should.exist(subs);
              subs.length.should.equal(1);
              var s = subs[0];
              s.token.should.equal('DEVICE_TOKEN');
              next();
            });
          },
          function(next) {
            helpers.getAuthServer(wallet.copayers[1].id, function(server) {
              server.pushNotificationsUnsubscribe({
                token: 'DEVICE_TOKEN'
              }, next);
            });
          },
          function(next) {
            server.storage.fetchPushNotificationSubs(wallet.copayers[0].id, function(err, subs) {
              should.not.exist(err);
              should.exist(subs);
              subs.length.should.equal(1);
              var s = subs[0];
              s.token.should.equal('DEVICE_TOKEN');
              next();
            });
          },
        ], function(err) {
          should.not.exist(err);
          done();
        });
      });
    });
  });

  describe('Tx confirmation notifications', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(2, 3, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should subscribe copayer to a tx confirmation', function(done) {
      helpers.getAuthServer(wallet.copayers[0].id, function(server) {
        should.exist(server);
        server.txConfirmationSubscribe({
          txid: '123',
        }, function(err) {
          should.not.exist(err);
          server.storage.fetchActiveTxConfirmationSubs(wallet.copayers[0].id, function(err, subs) {
            should.not.exist(err);
            should.exist(subs);
            subs.length.should.equal(1);
            var s = subs[0];
            s.txid.should.equal('123');
            s.isActive.should.be.true;
            done();
          });
        });
      });
    });

    it('should overwrite last subscription', function(done) {
      helpers.getAuthServer(wallet.copayers[0].id, function(server) {
        should.exist(server);
        server.txConfirmationSubscribe({
          txid: '123',
        }, function(err) {
          server.txConfirmationSubscribe({
            txid: '123',
          }, function(err) {
            should.not.exist(err);
            server.storage.fetchActiveTxConfirmationSubs(wallet.copayers[0].id, function(err, subs) {
              should.not.exist(err);
              should.exist(subs);
              subs.length.should.equal(1);
              done();
            });
          });
        });
      });
    });

    it('should unsubscribe copayer to the specified tx', function(done) {
      helpers.getAuthServer(wallet.copayers[0].id, function(server) {
        should.exist(server);
        async.series([

          function(next) {
            server.txConfirmationSubscribe({
              txid: '123',
            }, next);
          },
          function(next) {
            server.txConfirmationSubscribe({
              txid: '456',
            }, next);
          },
          function(next) {
            server.txConfirmationUnsubscribe({
              txid: '123',
            }, next);
          },
          function(next) {
            server.storage.fetchActiveTxConfirmationSubs(wallet.copayers[0].id, function(err, subs) {
              should.not.exist(err);
              should.exist(subs);
              subs.length.should.equal(1);
              var s = subs[0];
              s.txid.should.equal('456');
              next();
            });
          },
          function(next) {
            helpers.getAuthServer(wallet.copayers[1].id, function(server) {
              server.txConfirmationUnsubscribe({
                txid: '456'
              }, next);
            });
          },
          function(next) {
            server.storage.fetchActiveTxConfirmationSubs(wallet.copayers[0].id, function(err, subs) {
              should.not.exist(err);
              should.exist(subs);
              subs.length.should.equal(1);
              var s = subs[0];
              s.txid.should.equal('456');
              next();
            });
          },
        ], function(err) {
          should.not.exist(err);
          done();
        });
      });
    });
  });

  describe('#getWalletFromIdentifier', function() {
    var server, wallet;
    beforeEach(function(done) {
      helpers.createAndJoinWallet(1, 1, {}, function(s, w) {
        server = s;
        wallet = w;
        done();
      });
    });

    it('should get wallet from id', function(done) {
      server.getWalletFromIdentifier({
        identifier: wallet.id
      }, function(err, w) {
        should.not.exist(err);
        should.exist(w);
        w.id.should.equal(wallet.id);
        done();
      });
    });

    it('should get wallet from address', function(done) {
      server.createAddress({}, function(err, address) {
        should.not.exist(err);
        should.exist(address);
        server.getWalletFromIdentifier({
          identifier: address.address
        }, function(err, w) {
          should.not.exist(err);
          should.exist(w);
          w.id.should.equal(wallet.id);
          done();
        });
      });
    });

    it('should get wallet from tx proposal', function(done) {
      helpers.stubUtxos(server, wallet, 1, function() {
        helpers.stubBroadcast();
        var txOpts = {
          app: 'payment',
          params: {
            outputs: [{
              address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
              amount: 9e8,
            }],
          }
        };
        helpers.createAndPublishTx(server, txOpts, TestData.copayers[0].privKey_1H_0, function(txp) {
          should.exist(txp);
          var signatures = helpers.clientSign(txp, TestData.copayers[0].xPrivKey_44H_0H_0H, server.walletId);
          server.signTx({
            txProposalId: txp.id,
            signatures: signatures,
          }, function(err) {
            should.not.exist(err);
            server.getPendingTxs({}, function(err, txps) {
              should.not.exist(err);
              txp = txps[0];
              server.getWalletFromIdentifier({
                identifier: txp.txid
              }, function(err, w) {
                should.not.exist(err);
                should.exist(w);
                w.id.should.equal(wallet.id);
                done();
              });
            });
          });
        });
      });
    });

    it('should return nothing if identifier not associated with a wallet', function(done) {
      blockchainExplorer.getTransaction = sinon.stub().callsArgWith(1, null, null);
      server.getWalletFromIdentifier({
        identifier: 'dummy'
      }, function(err, w) {
        should.not.exist(err);
        should.not.exist(w);
        done();
      });
    });
  });

});
