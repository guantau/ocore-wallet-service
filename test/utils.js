'use strict';

var _ = require('lodash');
var chai = require('chai');
var sinon = require('sinon');
var should = chai.should();
var Utils = require('../lib/common/utils');

describe('Utils', function() {
  describe('#getMissingFields', function() {
    it('should check required fields', function() {
      var obj = {
        id: 'id',
        name: 'name',
        array: ['a', 'b'],
      };
      var fixtures = [{
        args: 'id',
        check: [],
      }, {
        args: ['id'],
        check: []
      }, {
        args: ['id, name'],
        check: ['id, name'],
      }, {
        args: ['id', 'name'],
        check: []
      }, {
        args: 'array',
        check: []
      }, {
        args: 'dummy',
        check: ['dummy']
      }, {
        args: ['dummy1', 'dummy2'],
        check: ['dummy1', 'dummy2']
      }, {
        args: ['id', 'dummy'],
        check: ['dummy']
      }, ];
      _.each(fixtures, function(f) {
        Utils.getMissingFields(obj, f.args).should.deep.equal(f.check);
      });
    });
    it('should fail to check required fields on non-object', function() {
      var obj = 'dummy';
      Utils.getMissingFields(obj, 'name').should.deep.equal(['name']);
    });
  });

  describe('#hashMessage', function() {
    it('should create a hash', function() {
      var res = Utils.hashMessage('hola');
      res.toString('hex').should.equal('4102b8a140ec642feaa1c645345f714bc7132d4fd2f7f6202db8db305a96172f');
    });
  });

  describe('#verifyMessage', function() {
    it('should fail to verify a malformed signature', function() {
      var res = Utils.verifyMessage('hola', 'badsignature', '02555a2d45e309c00cc8c5090b6ec533c6880ab2d3bc970b3943def989b3373f16');
      should.exist(res);
      res.should.equal(false);
    });
    it('should fail to verify a null signature', function() {
      var res = Utils.verifyMessage('hola', null, '02555a2d45e309c00cc8c5090b6ec533c6880ab2d3bc970b3943def989b3373f16');
      should.exist(res);
      res.should.equal(false);
    });
    it('should fail to verify with wrong pubkey', function() {
      var res = Utils.verifyMessage('hola', '3045022100d6186930e4cd9984e3168e15535e2297988555838ad10126d6c20d4ac0e74eb502201095a6319ea0a0de1f1e5fb50f7bf10b8069de10e0083e23dbbf8de9b8e02785', '02555a2d45e309c00cc8c5090b6ec533c6880ab2d3bc970b3943def989b3373f16');
      should.exist(res);
      res.should.equal(false);
    });
    it('should verify', function() {
      var res = Utils.verifyMessage('hola', '3045022100d6186930e4cd9984e3168e15535e2297988555838ad10126d6c20d4ac0e74eb502201095a6319ea0a0de1f1e5fb50f7bf10b8069de10e0083e23dbbf8de9b8e02785', '03bec86ad4a8a91fe7c11ec06af27246ec55094db3d86098b7d8b2f12afe47627f');
      should.exist(res);
      res.should.equal(true);
    });
  });

  describe('#formatAmount', function() {
    it('should successfully format amount', function() {
      var cases = [{
        args: [1, null, 'one'],
        expected: '1 BYTES',
      }, {
        args: [1, null, 'giga'],
        expected: '0.00 GB',
      }, {
        args: [0, null, 'one'],
        expected: '0 BYTES',
      }, {
        args: [12345678, null, 'one'],
        expected: '12,345,678 BYTES',
      }, {
        args: [12345678, null, 'giga'],
        expected: '0.0123457 GB',
      }, {
        args: [12345611, null, 'giga'],
        expected: '0.0123456 GB',
      }, {
        args: [1234, null, 'giga'],
        expected: '0.0000012 GB',
      }, {
        args: [1299, null, 'giga'],
        expected: '0.0000013 GB',
      }, {
        args: [129900000, null, 'giga'],
        expected: '0.1299 GB',
      }, {
        args: [1234567899999, null, 'giga'],
        expected: '1,234.5679 GB',
      }, {
        args: [12345678, null, 'one', {
          thousandsSeparator: '.'
        }],
        expected: '12.345.678 BYTES',
      }, {
        args: [12345678, null, 'giga', {
          decimalSeparator: ','
        }],
        expected: '0,0123457 GB',
      }, {
        args: [1234567899999, null, 'giga', {
          thousandsSeparator: ' ',
          decimalSeparator: ','
        }],
        expected: '1 234,5679 GB',
      }, ];

      _.each(cases, function(testCase) {
        Utils.formatAmount.apply(this, testCase.args).should.equal(testCase.expected);
      });
    });
  });
 
  describe('#parseVersion', function() {
    it('should parse version', function() {
      Utils.parseVersion('owc-2.3.1').should.deep.equal({
        agent:'owc',
        major:2,
        minor:3,
        patch:1,
      });
    });
    it('should parse version case 2', function() {
      Utils.parseVersion('xxss').should.deep.equal({
        agent:'xxss',
      });
    });
    it('should parse version case 3', function() {
      Utils.parseVersion('xxss-32').should.deep.equal({
        agent:'xxss',
        major:32,
        minor:null,
        patch:null,
      });
    });
  });
 
  describe('#parseAppVersion', function() {
    it('should parse user version', function() {
      Utils.parseAppVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OBYTEWEB/1.0.0 Chrome/66.0.3359.181 Electron/3.0.8 Safari/537.36').should.deep.equal({
        app:'web',
        major:1,
        minor:0,
        patch:0,
      });
    });
    it('should parse version case 2', function() {
      Utils.parseAppVersion('OBYTEAPP 1.0.0 (Android 8.0.0 - SM-N950U)').should.deep.equal({
        app:'app',
        major:1,
        minor:0,
        patch:0,
      });
    });
    it('should parse version case 3', function() {
      Utils.parseAppVersion('OBYTEAPP 1.0.0 (iOS 12.0 - iPhone9,2)').should.deep.equal({
        app:'app',
        major:1,
        minor:0,
        patch:0,
      });
    });
    it('should parse version case 4', function() {
      Utils.parseAppVersion('node-superagent/3.8.3').should.deep.equal({
        app:'other',
      });
    });
  });

  
});
