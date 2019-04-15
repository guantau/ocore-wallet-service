'use strict';

var _ = require('lodash');
var chai = require('chai');
var sinon = require('sinon');
var should = chai.should();
var Wallet = require('../../lib/model/wallet');
var Copayer = require('../../lib/model/copayer');


describe('Copayer', function() {

  describe('#fromObj', function() {
    it('read a copayer', function() {
      var c = Copayer.fromObj(testWallet.copayers[0]);
      c.name.should.equal('copayer 1');
    });
  });
  describe('#createAddress', function() {
    it('should create an address', function() {
      var w = Wallet.fromObj(testWallet);
      var c = Copayer.fromObj(testWallet.copayers[1]);
      should.exist(c.requestPubKeys);
      c.requestPubKeys.length.should.equal(1);
      var a1 = c.createAddress(w, false);
      a1.address.should.equal('UL34DNO2TOOQ4SI4IKA7U2IRBQQRGXQP');
      a1.path.should.equal('m/0/0');
      a1.createdOn.should.be.above(1);
      var a2 = c.createAddress(w, false);
      a2.path.should.equal('m/0/1');
    });
  });
});


var testWallet = {
  addressManager: {
    receiveAddressIndex: 0,
    changeAddressIndex: 0,
    copayerIndex: 2147483647,
  },
  createdOn: 1422904188,
  id: '123',
  name: '123 wallet',
  coin: 'obyte',
  network: 'livenet',
  m: 1,
  n: 2,
  status: 'complete',
  definitionTemplate: ["r of set",{"required":1,"set":[["sig",{"pubkey":"$pubkey@0Q6ETALGLU64DUMMZLLIYERH54HSC4QVA"}],["sig",{"pubkey":"$pubkey@0R5IXQWYA4FWKBUZ2J6XNOGCWJDRK53QA"}]]}],
  publicKeyRing: [{
    xPubKey: 'xpub6CJvw84e2SKLXixjy2M7sDe4hqFEVEypwao2MscY9f3jSoTx5Xc4YYaVfBF11vC6677H5mzYWPwJbpECqCWzsrEeAiRuQui8rDT2pTbdgAt',
    requestPubKey: '03814ac7decf64321a3c6967bfb746112fdb5b583531cd512cc3787eaf578947dc'
  }, {
    xPubKey: 'xpub6Ca7ryEMiifiEPiZSQ9mWteSR1X1PtezkzGhyyiMFKd9G1p1z81eDb3njTYS9FCoZ8azvpP72SrL4u83LhA8Hypusqo9nnCjrc34TTiCjf4',
    requestPubKey: '03fc086d2bd8b6507b1909b24c198c946e68775d745492ea4ca70adfce7be92a60'
  }, ],
  copayers: [{
    addressManager: {
      receiveAddressIndex: 0,
      changeAddressIndex: 0,
      copayerIndex: 0,
    },
    createdOn: 1422904189,
    id: '1',
    name: 'copayer 1',
    account: 0,
    deviceId: '0Q6ETALGLU64DUMMZLLIYERH54HSC4QVA',
    xPubKey: 'xpub6CJvw84e2SKLXixjy2M7sDe4hqFEVEypwao2MscY9f3jSoTx5Xc4YYaVfBF11vC6677H5mzYWPwJbpECqCWzsrEeAiRuQui8rDT2pTbdgAt',
    requestPubKey: '03814ac7decf64321a3c6967bfb746112fdb5b583531cd512cc3787eaf578947dc',
    signature: '30440220192ae7345d980f45f908bd63ccad60ce04270d07b91f1a9d92424a07a38af85202201591f0f71dd4e79d9206d2306862e6b8375e13a62c193953d768e884b6fb5a46',
    requestPubKeys: [{
      key: '03814ac7decf64321a3c6967bfb746112fdb5b583531cd512cc3787eaf578947dc',
      signature: '30440220192ae7345d980f45f908bd63ccad60ce04270d07b91f1a9d92424a07a38af85202201591f0f71dd4e79d9206d2306862e6b8375e13a62c193953d768e884b6fb5a46'
    }],
    version: 1,
  }, {
    addressManager: {
      receiveAddressIndex: 0,
      changeAddressIndex: 0,
      copayerIndex: 1,
    },
    createdOn: 1422904189,
    id: '2',
    name: 'copayer 2',
    account: 0,
    deviceId: '0R5IXQWYA4FWKBUZ2J6XNOGCWJDRK53QA',
    xPubKey: 'xpub6Ca7ryEMiifiEPiZSQ9mWteSR1X1PtezkzGhyyiMFKd9G1p1z81eDb3njTYS9FCoZ8azvpP72SrL4u83LhA8Hypusqo9nnCjrc34TTiCjf4',
    requestPubKey: '03fc086d2bd8b6507b1909b24c198c946e68775d745492ea4ca70adfce7be92a60',
    signature: '30440220134d13139323ba16ff26471c415035679ee18b2281bf85550ccdf6a370899153022066ef56ff97091b9be7dede8e40f50a3a8aad8205f2e3d8e194f39c20f3d15c62',
    requestPubKeys: [{
      key: '03fc086d2bd8b6507b1909b24c198c946e68775d745492ea4ca70adfce7be92a60',
      signature: '30440220134d13139323ba16ff26471c415035679ee18b2281bf85550ccdf6a370899153022066ef56ff97091b9be7dede8e40f50a3a8aad8205f2e3d8e194f39c20f3d15c62'
    }],
    version: '1.0.0',
  }],
  version: 1,
  pubKey: '{"x":"6092daeed8ecb2212869395770e956ffc9bf453f803e700f64ffa70c97a00d80","y":"ba5e7082351115af6f8a9eb218979c7ed1f8aa94214f627ae624ab00048b8650","compressed":true}',
  isTestnet: false
};
