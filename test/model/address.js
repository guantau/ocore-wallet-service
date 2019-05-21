'use strict';

var _ = require('lodash');
var chai = require('chai');
var sinon = require('sinon');
var should = chai.should();

var Address = require('../../lib/model/address');

describe('Address', function() {
  describe('#create', function() {
    it('should create livenet address', function() {
      var x = Address.create({
        address: '4WRW6DDL3OGCAOTMDHADZPJBQUOIZMS2',
        coin: 'obyte',
        network: 'livenet',
        walletId: '123',
        isChange: false,
        path: 'm/0/1',
        publicKeys: ['123', '456'],
      });
      should.exist(x.createdOn);
      x.network.should.equal('livenet');
    });
    it('should create testnet address', function() {
      var x = Address.create({
        address: '4WRW6DDL3OGCAOTMDHADZPJBQUOIZMS2',
        coin: 'obyte',
        network: 'testnet',
        walletId: '123',
        isChange: false,
        path: 'm/0/1',
        publicKeys: ['123', '456'],
      });
      x.network.should.equal('testnet');
    });
  });
  describe('#derive', function() {
    it('should derive 1-of-1 normal address', function() {
      var address = Address.derive('wallet-id', 
        ['sig', {'pubkey':'$pubkey@0Q6ETALGLU64DUMMZLLIYERH54HSC4QVA'}],
        [{xPubKey: 'xpub6CJvw84e2SKLXixjy2M7sDe4hqFEVEypwao2MscY9f3jSoTx5Xc4YYaVfBF11vC6677H5mzYWPwJbpECqCWzsrEeAiRuQui8rDT2pTbdgAt', deviceId: '0Q6ETALGLU64DUMMZLLIYERH54HSC4QVA'}],
        'm/0/0', 'normal', false);
      should.exist(address);
      address.walletId.should.equal('wallet-id');
      address.address.should.equal('6ERVBLCPMRFRZE25SGUL62FVFEDZ5NUH');
      address.network.should.equal('livenet');
      address.isChange.should.equal(false);
      address.path.should.equal('m/0/0');
      address.type.should.equal('normal');
    });
    it('should derive 1-of-2 shared address', function() {
      var address = Address.derive('wallet-id', 
        ["r of set",{"required":1,"set":[["sig",{"pubkey":"$pubkey@0Q6ETALGLU64DUMMZLLIYERH54HSC4QVA"}],["sig",{"pubkey":"$pubkey@0R5IXQWYA4FWKBUZ2J6XNOGCWJDRK53QA"}]]}],
        [{xPubKey: 'xpub6CJvw84e2SKLXixjy2M7sDe4hqFEVEypwao2MscY9f3jSoTx5Xc4YYaVfBF11vC6677H5mzYWPwJbpECqCWzsrEeAiRuQui8rDT2pTbdgAt', deviceId: '0Q6ETALGLU64DUMMZLLIYERH54HSC4QVA'}, {xPubKey: 'xpub6Ca7ryEMiifiEPiZSQ9mWteSR1X1PtezkzGhyyiMFKd9G1p1z81eDb3njTYS9FCoZ8azvpP72SrL4u83LhA8Hypusqo9nnCjrc34TTiCjf4', deviceId: '0R5IXQWYA4FWKBUZ2J6XNOGCWJDRK53QA'}], 
        'm/0/0', 'shared', false);
      should.exist(address);
      address.walletId.should.equal('wallet-id');
      address.address.should.equal('UL34DNO2TOOQ4SI4IKA7U2IRBQQRGXQP');
      address.network.should.equal('livenet');
      address.isChange.should.equal(false);
      address.path.should.equal('m/0/0');
      address.type.should.equal('shared');
    });
  });
});
