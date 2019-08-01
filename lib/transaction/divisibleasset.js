/*jslint node: true */
"use strict";
var _ = require('lodash');

var storage = require('ocore/storage.js');
var objectHash = require("ocore/object_hash.js");
var ValidationUtils = require('ocore/validation_utils.js');
var inputs = require('ocore/inputs.js');
var conf = require('ocore/conf.js');

var composer = require("./composer.js");


/** 
 * Compose a joint with divisible asset payment message
 * 
 * @param {Object} 
 * @param {String} params.asset - asset to be paid
 * @param {Array} params.paying_addresses - pay for asset outputs
 * @param {Array} params.signing_addresses [optional] - must sign the message but they do not necessarily pay 
 * @param {Array} params.fee_paying_addresses - pay for fee
 * @param {String} params.change_address - the address for change 
 * @param {String} params.to_address [optional] - the address for output
 * @param {Number} params.amount [optional] - the payment amount
 * @param {Array} params.base_outputs [optional] - the outputs for base payment
 * @param {Array} params.asset_outputs [optional] - the outputs for asset payment
 * @param {Boolean} params.minimal [optional] - use as few paying_addresses as possible
 * @param {String} params.spend_unconfirmed [optional] - default 'all', or 'own', 'none'
 * @param {Array} params.messages [optional] - external messages 
 * @param {Object} params.signer
 * @param {Callback} params.signer.readDefinition - read the address's definition
 * @param {Callback} params.signer.readSigningPath - read the address's signing path
 * @param {Object} params.callbacks
 * @param {Callback} params.callbacks.ifNotEnoughFunds - called if the funds are not enough
 * @param {Callback} params.callbacks.ifError - called if error
 * @param {Callback} params.callbacks.ifOk - called if ok
 */
function composeDivisibleAssetPaymentJoint(params){
	console.log("asset payment from "+params.paying_addresses);
	if ((params.to_address || params.amount) && params.asset_outputs)
		throw Error("to_address and asset_outputs at the same time");
	if (params.to_address && !params.amount)
		throw Error("to_address but not amount");
	if (!params.to_address && params.amount)
		throw Error("amount but not to_address");
	if (!params.to_address && !params.asset_outputs)
		throw Error("neither to_address nor asset_outputs");
	if (params.asset_outputs && !ValidationUtils.isNonemptyArray(params.asset_outputs))
		throw Error('asset_outputs must be non-empty array');
	if (!ValidationUtils.isNonemptyArray(params.fee_paying_addresses))
		throw Error('no fee_paying_addresses');

  var arrBaseOutputs = [{address: params.fee_paying_addresses[0], amount: 0}]; // public outputs: the change only
	if (params.base_outputs)
		arrBaseOutputs = arrBaseOutputs.concat(params.base_outputs);
	composer.composeJoint({
		paying_addresses: _.union(params.paying_addresses, params.fee_paying_addresses), // addresses that pay for the transfer and commissions
		signing_addresses: params.signing_addresses,
		minimal: params.minimal,
		outputs: arrBaseOutputs,
		messages: params.messages,
		spend_unconfirmed: params.spend_unconfirmed || 'all',
		// function that creates additional messages to be added to the joint
		retrieveMessages: function(conn, last_ball_mci, bMultiAuthored, arrPayingAddresses, onDone){
			var arrAssetPayingAddresses = _.intersection(arrPayingAddresses, params.paying_addresses);
			storage.loadAssetWithListOfAttestedAuthors(conn, params.asset, last_ball_mci, arrAssetPayingAddresses, function(err, objAsset){
				if (err)
					return onDone(err);
				if (objAsset.fixed_denominations)
					return onDone("fixed denominations asset type");
				// fix: also check change address when not transferrable
				if (!objAsset.is_transferrable && params.to_address !== objAsset.definer_address && arrAssetPayingAddresses.indexOf(objAsset.definer_address) === -1)
					return onDone("the asset is not transferrable and definer not found on either side of the deal");
				if (objAsset.cosigned_by_definer && arrPayingAddresses.concat(params.signing_addresses || []).indexOf(objAsset.definer_address) === -1)
					return onDone("the asset must be cosigned by definer");
				if (!conf.bLight && objAsset.spender_attested && objAsset.arrAttestedAddresses.length === 0)
          return onDone("none of the authors is attested");
        if (objAsset.is_private)
          return onDone("private asset is not supported");
				
				var target_amount = params.to_address 
					? params.amount 
					: params.asset_outputs.reduce(function(accumulator, output){ return accumulator + output.amount; }, 0);
				inputs.pickDivisibleCoinsForAmount(
					conn, objAsset, arrAssetPayingAddresses, last_ball_mci, target_amount, bMultiAuthored, params.spend_unconfirmed || 'all',
					function(arrInputsWithProofs, total_input){
						console.log("pick coins callback "+JSON.stringify(arrInputsWithProofs));
						if (!arrInputsWithProofs)
							return onDone({error_code: "NOT_ENOUGH_FUNDS", error: "not enough asset coins"});
						var arrOutputs = params.to_address ? [{address: params.to_address, amount: params.amount}] : params.asset_outputs;
						var change = total_input - target_amount;
						if (change > 0){
							var objChangeOutput = {address: params.change_address, amount: change};
							arrOutputs.push(objChangeOutput);
						}
						arrOutputs.sort(composer.sortOutputs);
						var payload = {
							asset: params.asset,
							inputs: arrInputsWithProofs.map(function(objInputWithProof){ return objInputWithProof.input; }),
							outputs: arrOutputs
						};
						var objMessage = {
							app: "payment",
							payload_location: objAsset.is_private ? "none" : "inline",
							payload_hash: objectHash.getBase64Hash(payload)
						};
						objMessage.payload = payload;
						onDone(null, [objMessage]);
					}
				);
			});
		},
		
		signer: params.signer, 
		
		callbacks: {
			ifError: params.callbacks.ifError,
			ifNotEnoughFunds: params.callbacks.ifNotEnoughFunds,
			ifOk: function(objJoint, composer_unlock_callback){
				params.callbacks.ifOk(objJoint, composer_unlock_callback);
			}
		}
	});
}


var TYPICAL_FEE = 1000;

// {asset: asset, available_paying_addresses: arrAvailablePayingAddresses, available_fee_paying_addresses: arrAvailableFeePayingAddresses, change_address: change_address, to_address: to_address, amount: amount, signer: signer, callbacks: callbacks}
function composeMinimalDivisibleAssetPaymentJoint(params){
		
	if (!ValidationUtils.isNonemptyArray(params.available_paying_addresses))
		throw Error('no available_paying_addresses');
	if (!ValidationUtils.isNonemptyArray(params.available_fee_paying_addresses))
		throw Error('no available_fee_paying_addresses');
  
    composer.readSortedFundedAddresses(params.asset, params.available_paying_addresses, params.amount, params.spend_unconfirmed || 'all', function(arrFundedPayingAddresses){
		if (arrFundedPayingAddresses.length === 0){
			 // special case for issuing uncapped asset.  If it is not issuing, not-enough-funds will pop anyway
			if (params.available_paying_addresses.length === 1)
				arrFundedPayingAddresses = params.available_paying_addresses.concat();
			else
				return params.callbacks.ifNotEnoughFunds("all paying addresses are unfunded in asset, make sure all your funds are confirmed");
    }
    
		composer.readSortedFundedAddresses(null, params.available_fee_paying_addresses, TYPICAL_FEE, params.spend_unconfirmed || 'all', function(arrFundedFeePayingAddresses){
			if (arrFundedFeePayingAddresses.length === 0)
				return params.callbacks.ifNotEnoughFunds("all paying addresses are unfunded in bytes necessary for fees, make sure all your funds are confirmed");
			var minimal_params = _.clone(params);
			delete minimal_params.available_paying_addresses;
			delete minimal_params.available_fee_paying_addresses;
			minimal_params.minimal = true;
			minimal_params.paying_addresses = arrFundedPayingAddresses;
			minimal_params.fee_paying_addresses = arrFundedFeePayingAddresses;
			composeDivisibleAssetPaymentJoint(minimal_params);
		});
	});
}


exports.composeDivisibleAssetPaymentJoint = composeDivisibleAssetPaymentJoint;
exports.composeMinimalDivisibleAssetPaymentJoint = composeMinimalDivisibleAssetPaymentJoint;
