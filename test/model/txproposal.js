"use strict";

var _ = require("lodash");
var chai = require("chai");
var sinon = require("sinon");
var should = chai.should();
var TxProposal = require("../../lib/model/txproposal");
var Bitcore = require("bitcore-lib");

describe("TxProposal", function() {
  describe("#create", function() {
    it("should create a TxProposal", function() {
      var txp = TxProposal.create(aTxpOpts());
      should.exist(txp);
      txp.network.should.equal("livenet");
    });
  });

  describe("#fromObj", function() {
    it("should copy a TxProposal", function() {
      var txp = TxProposal.fromObj(aTXP());
      should.exist(txp);
    });
    it("should default to obyte", function() {
      var txp = TxProposal.fromObj(aTXP());
      should.exist(txp);
      txp.coin.should.equal("obyte");
    });
  });

  describe("#sign", function() {
    it("should sign", function() {
      var txp = TxProposal.fromObj(aTXP());
      txp.sign("ewR+xNbUXIh8rYg1656AkBHuCCrYbrvehX+PxBAswho=", "4e7aa1fb-4fb8-4ad0-baac-995d0cf188b9", theSignatures, theXPub);
      txp.isAccepted().should.equal(true);
      txp.isRejected().should.equal(false);
    });
  });

  describe("#reject", function() {
    it("should reject", function() {
      var txp = TxProposal.fromObj(aTXP());
      txp.reject("ewR+xNbUXIh8rYg1656AkBHuCCrYbrvehX+PxBAswho=");
      txp.isAccepted().should.equal(false);
      txp.isRejected().should.equal(true);
    });
  });

});

var theXPriv =
  "xprv9s21ZrQH143K2rMHbXTJmWTuFx6ssqn1vyRoZqPkCXYchBSkp5ey8kMJe84sxfXq5uChWH4gk94rWbXZt2opN9kg4ufKGvUM7HQSLjnoh7e";
var theXPub =
  "xpub6CJvw84e2SKLXixjy2M7sDe4hqFEVEypwao2MscY9f3jSoTx5Xc4YYaVfBF11vC6677H5mzYWPwJbpECqCWzsrEeAiRuQui8rDT2pTbdgAt";
var theSignatures = {
  OXE4BG5KKSTSZI3S32DYDKWOREHOZHTN: {
    r:
      "JTVUfr7Sf9eUsuXoFxnMAqNKNbcwde9GBOuErjbGDaduHhOt+wQ5YnbEnKIFZIEASNg/rtcGp3r74F6tNoLzOg=="
  }
};

var aTxpOpts = function() {
  var opts = {
    coin: "obyte",
    network: "livenet",
  };

  return opts;
};

var aTXP = function() {

  var txp = {
    version: 1,
    createdOn: 1552832662,
    id: "5d2f3adb-007a-41fb-9ec3-a506648a8148",
    walletId: "4e7aa1fb-4fb8-4ad0-baac-995d0cf188b9",
    creatorId: "ewR+xNbUXIh8rYg1656AkBHuCCrYbrvehX+PxBAswho=",
    coin: "obyte",
    network: "livenet",
    message: null,
    changeAddress: {
      coin: "obyte",
      version: 1,
      createdOn: 1552832662,
      address: "4QRPWEA43LCHY2AK7LM2MCUHFHEGT7HW",
      walletId: "4e7aa1fb-4fb8-4ad0-baac-995d0cf188b9",
      definition: [
        "sig",
        { pubkey: "A2FqN6O9i7OVDxauC2dbokLeot37J7DuB7YaTlh0xK0Z" }
      ],
      signingPath: { A2FqN6O9i7OVDxauC2dbokLeot37J7DuB7YaTlh0xK0Z: "r" },
      isChange: true,
      path: "m/1/33",
      network: "livenet",
      type: "normal",
      hasActivity: null,
      beRegistered: null
    },
    walletM: 1,
    walletN: 1,
    requiredSignatures: 1,
    requiredRejections: 1,
    status: "broadcasted",
    stable: 0,
    txid: "mTiWonALeWwXY0YBlzAIpMO4SMDDwyzh5m9UbIKGNgk=",
    broadcastedOn: 1552832680,
    stabledOn: null,
    actions: [],
    addressType: "normal",
    customData: null,
    app: "payment",
    asset: null,
    unit: '{"version":"1.0","alt":"1","messages":[{"app":"payment","payload_location":"inline","payload_hash":"ZWvDlUQ+OF+6Xl0AusKzkDTRtUHXDKF0ka08xCpodZ8=","payload":{"outputs":[{"address":"4QRPWEA43LCHY2AK7LM2MCUHFHEGT7HW","amount":443126},{"address":"SK7XCACLDMRF4VJT4WNBVL5WEFDVMS2Q","amount":2000}],"inputs":[{"unit":"jt6scHbuA6W8hD6Du8YSzUUfZJuox3aF/QgNP/HFumw=","message_index":0,"output_index":0}]}}],"authors":[{"address":"OXE4BG5KKSTSZI3S32DYDKWOREHOZHTN","authentifiers":{"r":"JTVUfr7Sf9eUsuXoFxnMAqNKNbcwde9GBOuErjbGDaduHhOt+wQ5YnbEnKIFZIEASNg/rtcGp3r74F6tNoLzOg=="}}],"parent_units":["kTyDS3d/5Iex0g3Mu1yOQB6iuIHWyPgl1faMR2wKs98="],"last_ball":"UqdkTrgjgeAAXi3Ro3Gl/LHolcQnXPSgFqseya1N0uM=","last_ball_unit":"gELgsO7ouIKi6fWIxScOQYR8qywBuyWVnrGqEePdqkw=","witness_list_unit":"J8QFgTLI+3EkuAxX+eL6a0q114PJ4h4EOAiHAzxUp24=","headers_commission":344,"payload_commission":197,"timestamp":1552832662,"unit":"mTiWonALeWwXY0YBlzAIpMO4SMDDwyzh5m9UbIKGNgk="}',
    signingInfo: {
      OXE4BG5KKSTSZI3S32DYDKWOREHOZHTN: {
        walletId: "4e7aa1fb-4fb8-4ad0-baac-995d0cf188b9",
        path: "m/1/29",
        signingPaths: ["r"]
      }
    },
    proposalSignature:
      "3045022100e914f80989339a4fd8ecaf3afb5b4297fe5df184583d7ea04e449a1715617a95022051dabca24060a4ac4b4870dbe6d308c23e7385d3dce33978336491fa288191b8",
    proposalSignaturePubKey: null,
    proposalSignaturePubKeySig: null,
    derivationStrategy: "BIP44",
    creatorName:
      '{"iv":"SqlH6McAUEO32HLoNKiMGQ==","v":1,"iter":1,"ks":128,"ts":64,"mode":"ccm","adata":"","cipher":"aes","ct":"2LCsGbyJBPlgvNJW6kxit7Z9"}',
    isPending: false
  };

  return txp;
};
