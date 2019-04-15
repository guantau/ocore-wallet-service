/*jslint node: true */
"use strict";
var async = require('async');
var _ = require('lodash');

var conf = require('ocore/conf.js');
var storage = require('ocore/storage.js');
var objectHash = require("ocore/object_hash.js");
var db = require('ocore/db.js');
var constants = require("ocore/constants.js");
var ValidationUtils = require("ocore/validation_utils.js");

var composer = require("./composer.js");

var NOT_ENOUGH_FUNDS_ERROR_MESSAGE = "not enough indivisible asset coins that fit the desired amount within the specified tolerances, make sure all your funds are confirmed";


// must be executed within transaction
function updateIndivisibleOutputsThatWereReceivedUnstable(conn, onDone){
	
	function updateOutputProps(unit, is_serial, onUpdated){
		// may update several outputs
		conn.query(
			"UPDATE outputs SET is_serial=? WHERE unit=?", 
			[is_serial, unit],
			function(){
				is_serial ? updateInputUniqueness(unit, onUpdated) : onUpdated();
			}
		);
	}
	
	function updateInputUniqueness(unit, onUpdated){
		// may update several inputs
		conn.query("UPDATE inputs SET is_unique=1 WHERE unit=?", [unit], function(){
			onUpdated();
		});
	}
	
	console.log("updatePrivateIndivisibleOutputsThatWereReceivedUnstable starting");
	conn.query(
		"SELECT unit, message_index, sequence FROM outputs "+(conf.storage === 'sqlite' ? "INDEXED BY outputsIsSerial" : "")+" \n\
		JOIN units USING(unit) \n\
		WHERE outputs.is_serial IS NULL AND units.is_stable=1 AND is_spent=0", // is_spent=0 selects the final output in the chain
		function(rows){
			if (rows.length === 0)
				return onDone();
			async.eachSeries(
				rows,
				function(row, cb){
					
					function updateFinalOutputProps(is_serial){
						updateOutputProps(row.unit, is_serial, cb);
					}
					
					function goUp(unit, message_index){
						// we must have exactly 1 input per message
						conn.query(
							"SELECT src_unit, src_message_index, src_output_index \n\
							FROM inputs \n\
							WHERE unit=? AND message_index=?", 
							[unit, message_index],
							function(src_rows){
								if (src_rows.length === 0)
									throw Error("updating unstable: blackbyte input not found");
								if (src_rows.length > 1)
									throw Error("updating unstable: more than one input found");
								var src_row = src_rows[0];
								if (src_row.src_unit === null) // reached root of the chain (issue)
									return cb();
								conn.query(
									"SELECT sequence, is_stable, is_serial FROM outputs JOIN units USING(unit) \n\
									WHERE unit=? AND message_index=? AND output_index=?", 
									[src_row.src_unit, src_row.src_message_index, src_row.src_output_index],
									function(prev_rows){
										if (prev_rows.length === 0)
											throw Error("src unit not found");
										var prev_output = prev_rows[0];
										if (prev_output.is_serial === 0)
											throw Error("prev is already nonserial");
										if (prev_output.is_stable === 0)
											throw Error("prev is not stable");
										if (prev_output.is_serial === 1 && prev_output.sequence !== 'good')
											throw Error("prev is_serial=1 but seq!=good");
										if (prev_output.is_serial === 1) // already was stable when initially received
											return cb();
										var is_serial = (prev_output.sequence === 'good') ? 1 : 0;
										updateOutputProps(src_row.src_unit, is_serial, function(){
											if (!is_serial) // overwrite the tip of the chain
												return updateFinalOutputProps(0);
											goUp(src_row.src_unit, src_row.src_message_index);
										});
									}
								);
							}
						);
					}
					
					var is_serial = (row.sequence === 'good') ? 1 : 0;
					updateOutputProps(row.unit, is_serial, function(){
						goUp(row.unit, row.message_index);
					});
				},
				onDone
			);
		}
	);
}

function pickIndivisibleCoinsForAmount(
	conn, objAsset, arrAddresses, last_ball_mci, to_address, change_address, amount, tolerance_plus, tolerance_minus,
	bMultiAuthored, spend_unconfirmed, onDone)
{
	if (!ValidationUtils.isPositiveInteger(amount))
		throw Error("bad amount: "+amount);
	updateIndivisibleOutputsThatWereReceivedUnstable(conn, function(){
		console.log("updatePrivateIndivisibleOutputsThatWereReceivedUnstable done");
		var arrPayloadsWithProofs = [];
		var arrOutputIds = [];
		var accumulated_amount = 0;
		var asset = objAsset.asset;
		
		if (!(typeof last_ball_mci === 'number' && last_ball_mci >= 0))
			throw Error("invalid last_ball_mci: "+last_ball_mci);
		var confirmation_condition;
		if (spend_unconfirmed === 'none')
			confirmation_condition = 'AND main_chain_index<='+last_ball_mci+' AND +is_serial=1';
		else if (spend_unconfirmed === 'all')
			confirmation_condition = '';
		else if (spend_unconfirmed === 'own')
			confirmation_condition = 'AND ( main_chain_index<='+last_ball_mci+' AND +is_serial=1 OR EXISTS ( \n\
				SELECT 1 FROM unit_authors CROSS JOIN my_addresses USING(address) WHERE unit_authors.unit=outputs.unit \n\
				UNION \n\
				SELECT 1 FROM unit_authors CROSS JOIN shared_addresses ON address=shared_address WHERE unit_authors.unit=outputs.unit \n\
			) )';
		else
			throw Error("invalid spend_unconfirmed="+spend_unconfirmed);
		
		function createOutputs(amount_to_use, change_amount){
			var output = {
				address: to_address,
				amount: amount_to_use
			};
			if (objAsset.is_private)
				output.blinding = composer.generateBlinding();
			var outputs = [output];
			if (change_amount){
				var change_output = {
					address: change_address,
					amount: change_amount
				};
				if (objAsset.is_private)
					change_output.blinding = composer.generateBlinding();
				outputs.push(change_output);
				outputs.sort(function(o1, o2){ return (o1.address < o2.address) ? -1 : 1; });
			}
			return outputs;
		}
		
		function pickNextCoin(remaining_amount){
			console.log("looking for output for "+remaining_amount);
			if (remaining_amount <= 0)
				throw Error("remaining amount is "+remaining_amount);
			conn.query(
				"SELECT output_id, unit, message_index, output_index, amount, denomination, address, blinding, is_stable \n\
				FROM outputs CROSS JOIN units USING(unit) \n\
				WHERE asset=? AND address IN(?) AND is_spent=0 AND sequence='good' \n\
					"+confirmation_condition+" AND denomination<=? AND output_id NOT IN(?) \n\
				ORDER BY denomination DESC, (amount>=?) DESC, ABS(amount-?) LIMIT 1",
				[asset, arrAddresses, 
				remaining_amount, (arrOutputIds.length > 0) ? arrOutputIds : -1, 
				remaining_amount + tolerance_plus, remaining_amount],
				function(rows){
					if (rows.length === 0)
						return issueNextCoinIfAllowed(remaining_amount);
					var row = rows[0];
					if (row.is_stable === 0 && spend_unconfirmed === 'none') // contradicts to main_chain_index<=last_ball_mci
						throw Error("unstable or nonserial unit");
					var input = {
						unit: row.unit,
						message_index: row.message_index,
						output_index: row.output_index
					};
					var amount_to_use;
					var change_amount;
					if (row.amount > remaining_amount + tolerance_plus){
						// take the maximum that the denomination allows
						amount_to_use = Math.floor((remaining_amount + tolerance_plus)/row.denomination) * row.denomination;
						change_amount = row.amount - amount_to_use;
					}
					else
						amount_to_use = row.amount;
					var payload = {
						asset: asset,
						denomination: row.denomination,
						inputs: [input],
						outputs: createOutputs(amount_to_use, change_amount)
					};
					var objPayloadWithProof = {payload: payload, input_address: row.address};
					if (objAsset.is_private){
						var spend_proof = objectHash.getBase64Hash({
							asset: asset,
							unit: row.unit,
							message_index: row.message_index,
							output_index: row.output_index,
							address: row.address,
							amount: row.amount,
							blinding: row.blinding
						});
						var objSpendProof = {
							spend_proof: spend_proof
						};
						if (bMultiAuthored)
							objSpendProof.address = row.address;
						objPayloadWithProof.spend_proof = objSpendProof;
					}
					arrPayloadsWithProofs.push(objPayloadWithProof);
					arrOutputIds.push(row.output_id);
					accumulated_amount += amount_to_use;
					if (accumulated_amount >= amount - tolerance_minus && accumulated_amount <= amount + tolerance_plus)
						return onDone(null, arrPayloadsWithProofs);
					if (arrPayloadsWithProofs.length >= constants.MAX_MESSAGES_PER_UNIT - 1) // reserve 1 for fees
						return onDone("Too many messages, try sending a smaller amount");
					pickNextCoin(amount - accumulated_amount);
				}
			);
		}
		
		function issueNextCoinIfAllowed(remaining_amount){
			return (!objAsset.issued_by_definer_only || arrAddresses.indexOf(objAsset.definer_address) >= 0) 
				? issueNextCoin(remaining_amount) 
				: onDone(NOT_ENOUGH_FUNDS_ERROR_MESSAGE);
		}
		
		function issueNextCoin(remaining_amount){
			console.log("issuing a new coin");
			if (remaining_amount <= 0)
				throw Error("remaining amount is "+remaining_amount);
			var issuer_address = objAsset.issued_by_definer_only ? objAsset.definer_address : arrAddresses[0];
			var can_issue_condition = objAsset.cap ? "max_issued_serial_number=0" : "1";
			conn.query(
				"SELECT denomination, count_coins, max_issued_serial_number FROM asset_denominations \n\
				WHERE asset=? AND "+can_issue_condition+" AND denomination<=? \n\
				ORDER BY denomination DESC LIMIT 1", 
				[asset, remaining_amount+tolerance_plus], 
				function(rows){
					if (rows.length === 0)
						return onDone(NOT_ENOUGH_FUNDS_ERROR_MESSAGE);
					var row = rows[0];
					if (!!row.count_coins !== !!objAsset.cap)
						throw Error("invalid asset cap and count_coins");
					var denomination = row.denomination;
					var serial_number = row.max_issued_serial_number+1;
					var count_coins_to_issue = row.count_coins || Math.floor((remaining_amount+tolerance_plus)/denomination);
					var issue_amount = count_coins_to_issue * denomination;
					conn.query(
						"UPDATE asset_denominations SET max_issued_serial_number=max_issued_serial_number+1 WHERE denomination=? AND asset=?", 
						[denomination, asset], 
						function(){
							var input = {
								type: 'issue',
								serial_number: serial_number,
								amount: issue_amount
							};
							if (bMultiAuthored)
								input.address = issuer_address;
							var amount_to_use;
							var change_amount;
							if (issue_amount > remaining_amount + tolerance_plus){
								amount_to_use = Math.floor((remaining_amount + tolerance_plus)/denomination) * denomination;
								change_amount = issue_amount - amount_to_use;
							}
							else
								amount_to_use = issue_amount;
							var payload = {
								asset: asset,
								denomination: denomination,
								inputs: [input],
								outputs: createOutputs(amount_to_use, change_amount)
							};
							var objPayloadWithProof = {payload: payload, input_address: issuer_address};
							if (objAsset.is_private){
								var spend_proof = objectHash.getBase64Hash({
									asset: asset,
									address: issuer_address,
									serial_number: serial_number, // need to avoid duplicate spend proofs when issuing uncapped coins
									denomination: denomination,
									amount: input.amount
								});
								var objSpendProof = {
									spend_proof: spend_proof
								};
								if (bMultiAuthored)
									objSpendProof.address = issuer_address;
								objPayloadWithProof.spend_proof = objSpendProof;
							}
							arrPayloadsWithProofs.push(objPayloadWithProof);
							accumulated_amount += amount_to_use;
							console.log("payloads with proofs: "+JSON.stringify(arrPayloadsWithProofs));
							if (accumulated_amount >= amount - tolerance_minus && accumulated_amount <= amount + tolerance_plus)
								return onDone(null, arrPayloadsWithProofs);
							pickNextCoin(amount - accumulated_amount);
						}
					);
				}
			);
		}
				
		var arrSpendableAddresses = arrAddresses.concat(); // cloning
		if (objAsset && objAsset.auto_destroy){
			var i = arrAddresses.indexOf(objAsset.definer_address);
			if (i>=0)
				arrSpendableAddresses.splice(i, 1);
		}
		if (arrSpendableAddresses.length > 0)
			pickNextCoin(amount);
		else
			issueNextCoinIfAllowed(amount);
	});
}


/**
 * Randomize array element order in-place.
 * Using Durstenfeld shuffle algorithm.
 */
function shuffleArray(array) {
	for (var i = array.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var temp = array[i];
		array[i] = array[j];
		array[j] = temp;
	}
	return array;
}


function composeIndivisibleAssetPaymentJoint(params){
	console.log("indivisible payment from "+params.paying_addresses, params);
	if ((params.to_address || params.amount) && params.asset_outputs)
		throw Error("to_address and asset_outputs at the same time");
	if (params.asset_outputs && params.asset_outputs.length !== 1)
		throw Error("multiple indivisible asset outputs not supported");
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
		spend_unconfirmed: params.spend_unconfirmed || 'own',
		
		// function that creates additional messages to be added to the joint
		retrieveMessages: function createAdditionalMessages(conn, last_ball_mci, bMultiAuthored, arrPayingAddresses, onDone){
			var arrAssetPayingAddresses = _.intersection(arrPayingAddresses, params.paying_addresses);
			storage.loadAssetWithListOfAttestedAuthors(conn, params.asset, last_ball_mci, arrAssetPayingAddresses, function(err, objAsset){
				if (err)
					return onDone(err);
				if (!objAsset.fixed_denominations)
					return onDone("divisible asset type");
				if (!objAsset.is_transferrable && params.to_address !== objAsset.definer_address && arrAssetPayingAddresses.indexOf(objAsset.definer_address) === -1)
					return onDone("the asset is not transferrable and definer not found on either side of the deal");
				if (objAsset.cosigned_by_definer && arrPayingAddresses.concat(params.signing_addresses || []).indexOf(objAsset.definer_address) === -1)
					return onDone("the asset must be cosigned by definer");
				if (objAsset.spender_attested && objAsset.arrAttestedAddresses.length === 0)
					return onDone("none of the authors is attested");

				var target_amount = params.to_address ? params.amount : params.asset_outputs[0].amount;
				var to_address = params.to_address ? params.to_address : params.asset_outputs[0].address;
				pickIndivisibleCoinsForAmount(
					conn, objAsset, arrAssetPayingAddresses, last_ball_mci, 
					to_address, params.change_address,
					target_amount, params.tolerance_plus || 0, params.tolerance_minus || 0, 
					bMultiAuthored, params.spend_unconfirmed || 'own',
					function(err, arrPayloadsWithProofs){
						if (!arrPayloadsWithProofs)
							return onDone({
								error_code: "NOT_ENOUGH_FUNDS", 
								error: err
							});
						var arrMessages = [];
						for (var i=0; i<arrPayloadsWithProofs.length; i++){
							var payload = arrPayloadsWithProofs[i].payload;
							var payload_hash;// = objectHash.getBase64Hash(payload);
							if (objAsset.is_private){
								payload.outputs.forEach(function(o){
									o.output_hash = objectHash.getBase64Hash({address: o.address, blinding: o.blinding});
								});
								var hidden_payload = _.cloneDeep(payload);
								hidden_payload.outputs.forEach(function(o){
									delete o.address;
									delete o.blinding;
								});
								payload_hash = objectHash.getBase64Hash(hidden_payload);
							}
							else
								payload_hash = objectHash.getBase64Hash(payload);
							var objMessage = {
								app: "payment",
								payload_location: objAsset.is_private ? "none" : "inline",
								payload_hash: payload_hash
							};
							objMessage.payload = payload;
							arrMessages.push(objMessage);
						}
						// messages are sorted in descending order by denomination of the coin, so shuffle them to avoid giving any clues
						shuffleArray(arrMessages);
						console.log("composed messages "+JSON.stringify(arrMessages));
						onDone(null, arrMessages);
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


function readAddressesFundedInAsset(asset, amount, spend_unconfirmed, arrAvailablePayingAddresses, handleFundedAddresses){
	var inputs = require('./inputs.js');
	var remaining_amount = amount;
	var assocAddresses = {};
	db.query(
		"SELECT amount, denomination, address FROM outputs CROSS JOIN units USING(unit) \n\
		WHERE is_spent=0 AND address IN(?) "+inputs.getConfirmationConditionSql(spend_unconfirmed)+" AND sequence='good' AND asset=? \n\
			AND NOT EXISTS ( \n\
				SELECT * FROM unit_authors JOIN units USING(unit) \n\
				WHERE is_stable=0 AND unit_authors.address=outputs.address AND definition_chash IS NOT NULL \n\
			) \n\
		ORDER BY denomination DESC, amount DESC",
		[arrAvailablePayingAddresses, asset],
		function(rows){
			for (var i=0; i<rows.length; i++){
				var row = rows[i];
				if (row.denomination > remaining_amount)
					continue;
				assocAddresses[row.address] = true;
				var used_amount = (row.amount <= remaining_amount) ? row.amount : row.denomination * Math.floor(remaining_amount/row.denomination);
				remaining_amount -= used_amount;
				if (remaining_amount === 0)
					break;
			};
			var arrAddresses = Object.keys(assocAddresses);
			handleFundedAddresses(arrAddresses);
		}
	);
}

var TYPICAL_FEE = 3000;

// reads addresses funded in asset plus addresses for paying commissions
function readFundedAddresses(asset, amount, arrAvailablePayingAddresses, arrAvailableFeePayingAddresses, spend_unconfirmed, handleFundedAddresses){
	readAddressesFundedInAsset(asset, amount, spend_unconfirmed, arrAvailablePayingAddresses, function(arrAddressesFundedInAsset){
		// add other addresses to pay for commissions (in case arrAddressesFundedInAsset don't have enough bytes to pay commissions)
	//	var arrOtherAddresses = _.difference(arrAvailablePayingAddresses, arrAddressesFundedInAsset);
	//	if (arrOtherAddresses.length === 0)
	//		return handleFundedAddresses(arrAddressesFundedInAsset);
		composer.readSortedFundedAddresses(null, arrAvailableFeePayingAddresses, TYPICAL_FEE, spend_unconfirmed, function(arrFundedFeePayingAddresses){
		//	if (arrFundedOtherAddresses.length === 0)
		//		return handleFundedAddresses(arrAddressesFundedInAsset);
		//	handleFundedAddresses(arrAddressesFundedInAsset.concat(arrFundedOtherAddresses));
			if (arrFundedFeePayingAddresses.length === 0)
				throw new Error("no funded fee paying addresses out of "+arrAvailableFeePayingAddresses.join(', '));
			handleFundedAddresses(arrAddressesFundedInAsset, arrFundedFeePayingAddresses);
		});
	});
}

// {asset: asset, available_paying_addresses: arrAvailablePayingAddresses, available_fee_paying_addresses: arrAvailableFeePayingAddresses, to_address: to_address, change_address: change_address, amount: amount, tolerance_plus: tolerance_plus, tolerance_minus: tolerance_minus, signer: signer, callbacks: callbacks}
function composeMinimalIndivisibleAssetPaymentJoint(params){
	if (!ValidationUtils.isNonemptyArray(params.available_paying_addresses))
		throw Error('no available_paying_addresses');
	if (!ValidationUtils.isNonemptyArray(params.available_fee_paying_addresses))
		throw Error('no available_fee_paying_addresses');
	var target_amount;
	if (params.amount)
		target_amount = params.amount;
	else if (params.asset_outputs)
		target_amount = params.asset_outputs.reduce(function(accumulator, output){ return accumulator + output.amount; }, 0);
	if (!target_amount)
		throw Error("no target amount");
	readFundedAddresses(
		params.asset, target_amount, params.available_paying_addresses, params.available_fee_paying_addresses, params.spend_unconfirmed || 'own',
		function(arrFundedPayingAddresses, arrFundedFeePayingAddresses){
			if (arrFundedPayingAddresses.length === 0)
				return params.callbacks.ifNotEnoughFunds("either the amount you entered can't be composed using available denominations or all paying addresses are unfunded in asset, make sure all your funds are confirmed");
			var minimal_params = _.clone(params);
			delete minimal_params.available_paying_addresses;
			delete minimal_params.available_fee_paying_addresses;
			minimal_params.minimal = true;
			minimal_params.paying_addresses = arrFundedPayingAddresses;
			minimal_params.fee_paying_addresses = arrFundedFeePayingAddresses;
			composeIndivisibleAssetPaymentJoint(minimal_params);
		}
	);
}


function getToAddress(params){
	if (params.to_address)
		return params.to_address;
	if (params.asset_outputs)
		return params.asset_outputs[0].address;
	throw Error("unable to determine to_address");
}


exports.composeMinimalIndivisibleAssetPaymentJoint = composeMinimalIndivisibleAssetPaymentJoint;
exports.updateIndivisibleOutputsThatWereReceivedUnstable = updateIndivisibleOutputsThatWereReceivedUnstable;
