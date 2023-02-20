import {ApiPromise} from "@polkadot/api";
import { xxhashAsHex } from "@polkadot/util-crypto";
import {AccountInfo, Balance, Hash, ProxyDefinition, ContractInfo, PrefabWasmModule, BalanceLock,StakingLedger,ValidatorCount,} from "@polkadot/types/interfaces";
import {insertOrNewArray, StorageItem, StorageValueValue, StorageMapValue, getOrInsertMap} from "../migration/common";
import {StorageKey} from "@polkadot/types";
import {compactAddLength} from "@polkadot/util";

// Transform the source state to match the appropriate schema in the destination
export async function transform(
    forkData: Map<string, Array<[ StorageKey, Uint8Array]>>,
    fromApi: ApiPromise,
    toApi: ApiPromise,
    startFrom: Hash,
    atFrom: Hash,
    atTo: Hash
): Promise<Map<string, Map<string, Array<StorageItem>>>>   {
    let state: Map<string, Map<string, Array<StorageItem>>> = new Map();
    // For every prefix do the correct transformation.
    for (let [key, keyValues] of forkData) {
        // Match all prefixes we want to transform
        if (key.startsWith(xxhashAsHex("System",128))) {
             let palletKey = xxhashAsHex("System", 128);
             let palletItems = getOrInsertMap(state, palletKey);
             await transformSystem(fromApi, toApi, palletItems, keyValues);
        } else if (key.startsWith(xxhashAsHex("Contracts",128))) {
            let palletKey = xxhashAsHex("Contracts", 128);
            let palletItems = getOrInsertMap(state, palletKey);
            await transformContract(fromApi, toApi, palletItems, keyValues);
        } else if (key.startsWith(xxhashAsHex("Staking",128))) {
            let palletKey = xxhashAsHex("Staking", 128);
            let palletItems = getOrInsertMap(state, palletKey);
            await transformStaking(fromApi, toApi, palletItems, keyValues);
        
        } else if (key.startsWith(xxhashAsHex("Balances", 128))) {
            let palletKey = xxhashAsHex("Balances", 128);
            let palletItems = getOrInsertMap(state, palletKey);
            await transformBalances(fromApi, toApi, palletItems, keyValues);

        } else if (key.startsWith(xxhashAsHex("Vesting", 128))) {
            let palletKey = xxhashAsHex("Vesting", 128);
            let palletItems = getOrInsertMap(state, palletKey);
            await transformVesting(fromApi, toApi, palletItems, keyValues, startFrom, atTo);

        } else if (key.startsWith(xxhashAsHex("Proxy", 128))) {
            let palletKey = xxhashAsHex("Proxy", 128);
            let palletItems = getOrInsertMap(state, palletKey);
            await transformProxy(fromApi, toApi, palletItems, keyValues);

        } else if (key.startsWith(xxhashAsHex("RadClaims", 128))) {
            let palletKey = xxhashAsHex("Claims", 128);
            let palletItems = getOrInsertMap(state, palletKey);
            await transformClaims(fromApi, toApi, palletItems, keyValues);

        } else {
            return Promise.reject("Fetched data that can not be transformed. PatriciaKey is: " + key);
        }
    }

    return state;
}

async function transformClaims (fromApi: ApiPromise, toApi: ApiPromise, state: Map<string, Array<StorageItem>>, keyValues: Array<[StorageKey, Uint8Array]>) {
    for(let [patriciaKey, value] of keyValues) {
        if (patriciaKey.toHex().startsWith(xxhashAsHex("RadClaims", 128) + xxhashAsHex("AccountBalances", 128).slice(2))) {
            let pkStorageItem = xxhashAsHex("Claims", 128) + xxhashAsHex("ClaimedAmounts", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformClaimsClaimedAmounts(fromApi, toApi, patriciaKey, value));
        } else if (patriciaKey.toHex().startsWith(xxhashAsHex("RadClaims", 128) + xxhashAsHex("UploadAccount", 128).slice(2))) {
            let pkStorageItem = xxhashAsHex("Claims", 128) + xxhashAsHex("UploadAccount", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformClaimsUploadAccount(fromApi, toApi, patriciaKey, value));

        } else {
            return Promise.reject("Fetched data that can not be transformed. PatriciaKey is: " + patriciaKey.toHuman());
        }
    }
}

async function transformClaimsClaimedAmounts(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleClaimedAmountsUser:  Uint8Array): Promise<StorageItem> {
    // We need to update the pallet and the item hash prefixes of the key here
    let newPrefix = xxhashAsHex("Claims", 128) + xxhashAsHex("ClaimedAmounts", 128).slice(2);
    // First 64 characters plus 0x from hex representation
    let keyWithoutPrefix = completeKey.toHex().slice(66);
    let newKey = toApi.createType("StorageKey", newPrefix + keyWithoutPrefix);
    return new StorageMapValue(scaleClaimedAmountsUser, newKey);

}

async function transformClaimsUploadAccount(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleUploadAccount:  Uint8Array): Promise<StorageItem> {
    // We don't need to update the patricia key here as we will generate the correct one in the migration during
    // creation of the set_storage extrinsic
    return new StorageValueValue(scaleUploadAccount);
}

async function transformProxy(
    fromApi: ApiPromise,
    toApi: ApiPromise,
    state: Map<string, Array<StorageItem>>,
    keyValues: Array<[StorageKey, Uint8Array]>
) {

    // Match against the actual storage items of a pallet.
    for(let [patriciaKey, value] of keyValues) {
        if (patriciaKey.toHex().startsWith(xxhashAsHex("Proxy", 128) + xxhashAsHex("Proxies", 128).slice(2))) {
            let pkStorageItem = xxhashAsHex("Proxy", 128) + xxhashAsHex("Proxies", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformProxyProxies(fromApi, toApi, patriciaKey, value));
        } else {
            return Promise.reject("Fetched data that can not be transformed. PatriciaKey is: " + patriciaKey.toHuman());
        }
    }
}

async function transformProxyProxies(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldProxies:  Uint8Array): Promise<StorageItem> {
    // @ts-ignore, see https://github.com/polkadot-js/api/issues/3746
    let oldProxyInfo = fromApi.createType('(Vec<(AccountId, ProxyType)>, Balance)', scaleOldProxies);

    let proxies: Array<ProxyDefinition> = new Array();

    // For the checks if anonymous proxies, we check if CINC is part of the proxies. Which indicates, that
    // that it is indeed an anonymous proxy. As CINC itself is a multisig...
    const CINC =  fromApi.createType("AccountId", "4djGpfJtHkS3kXBNtSFijf8xHbBY8mYvnUR7zrLM9bCyF7Js");
    let CINCisDelegate = false;

    // 1. Iterate over all elements of the vector
    // 2. Create a `ProxyDefinition` for each element
    // @ts-ignore // Not sure, how we can define an actual type here. Think this has no interface on the polkadot-api side
    for (const oldElement of oldProxyInfo[0]) {
        let delegate = toApi.createType("AccountId", oldElement[0]);
        if (CINC.toHex() === delegate.toHex()) {
            CINCisDelegate = true;
        }

        let proxyType = toApi.createType("ProxyType", oldElement[1]);

        let delay = toApi.createType("BlockNumber", 0);

        let proxyDef = toApi.createType("ProxyDefinition",
            [
                delegate,
                proxyType,
                delay
            ]);

        proxies.push(proxyDef);
    }

    // @ts-ignore // Not sure, how we can define an actual type here. Think this has no interface on the polkadot-api side
    let deposit = toApi.createType("Balance", oldProxyInfo[1]);

    // @ts-ignore, see https://github.com/polkadot-js/api/issues/3746
    let newProxyInfo = toApi.createType('(Vec<ProxyDefinition<AccountId, ProxyType, BlockNumber>>, Balance)',
    [
                proxies,
                deposit
        ]
    );

    // We must somehow detect the anonymous proxies. This can only be done on a best effort basis.
    // The reason for this is, that when an anonymous proxy did some actions, that included the reserve of
    // his balances, the logic below will not detect it, if the reserve goes above the threshold. There is no other
    // way to detect an anonymous proxy otherwise...
    const proxiedAccount = fromApi.createType("AccountId", completeKey.slice(-32));
    const { nonce, data: balance } = await fromApi.query.system.account(proxiedAccount);
    const base = await fromApi.consts.proxy.proxyDepositBase;
    const perProxy = await fromApi.consts.proxy.proxyDepositFactor;

    let reserve: Balance;
    // In the case that we see that the amount reserved is smaller than 350 mCFG, we can be sure, that this
    // is an anonymous proxy. The reverse does not prove the non-existence of an anonymous proxy!
    // Hence, we must ensure, that we subtract 350 mCFg from the deposit, as this one is reserved on the creator!
    if (balance.reserved.toBigInt() < (BigInt(proxies.length) * perProxy.toBigInt()) + base.toBigInt()) {
        let amount = deposit.toBigInt() - (perProxy.toBigInt() + base.toBigInt());
        reserve = toApi.createType("Balance", amount);
    } else if (CINCisDelegate) {
        let amount = deposit.toBigInt() - (perProxy.toBigInt() + base.toBigInt());
        reserve = toApi.createType("Balance", amount);
    } else {
        reserve = toApi.createType("Balance", deposit);
    }

    return new StorageMapValue(newProxyInfo.toU8a(), completeKey, reserve);
}

async function transformContract(
    fromApi: ApiPromise,
    toApi: ApiPromise,
    state: Map<string, Array<StorageItem>>,
    keyValues: Array<[StorageKey, Uint8Array ]>
) {
    // Match against the actual storage items of a pallet.
    for(let [patriciaKey, value] of keyValues) {
        let codeStorage = xxhashAsHex("Contracts", 128) + xxhashAsHex("CodeStorage", 128).slice(2);
        let contractInfo = xxhashAsHex("Contracts", 128) + xxhashAsHex("ContractInfoOf", 128).slice(2);
        if (patriciaKey.toHex().startsWith(codeStorage)) {
            let pkStorageItem = xxhashAsHex("Contracts", 128) + xxhashAsHex("CodeStorage", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformContractCodeStorage(fromApi, toApi, patriciaKey, value));
        } else if (patriciaKey.toHex().startsWith(contractInfo)) {
            let pkStorageItem = xxhashAsHex("Contracts", 128) + xxhashAsHex("ContractInfoOf", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformContractContractInfoOf(fromApi, toApi, patriciaKey, value));
        }
        else {
            return Promise.reject("Fetched data that can not be transformed. PatriciaKey is: " + patriciaKey.toHuman());
        }
    }
}

async function transformStaking(
    fromApi: ApiPromise,
    toApi: ApiPromise,
    state: Map<string, Array<StorageItem>>,
    keyValues: Array<[StorageKey, Uint8Array ]>
) {
    // Match against the actual storage items of a pallet.
    for(let [patriciaKey, value] of keyValues) {
        let codeStorage = xxhashAsHex("Staking", 128) + xxhashAsHex("Ledger", 128).slice(2);
        let codeStorage2 = xxhashAsHex("Staking", 128) + xxhashAsHex("ValidatorCount", 128).slice(2);
        let codeStorage3 = xxhashAsHex("Staking", 128) + xxhashAsHex("Bonded", 128).slice(2);
        if (patriciaKey.toHex().startsWith(codeStorage)) {
            let pkStorageItem = xxhashAsHex("Staking", 128) + xxhashAsHex("Ledger", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformStakingLedger(fromApi, toApi, patriciaKey, value));
        } 
        else if (patriciaKey.toHex().startsWith(codeStorage2)) {
            let pkStorageItem = xxhashAsHex("Staking", 128) + xxhashAsHex("ValidatorCount", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformStakingValidatorCount(fromApi, toApi, patriciaKey, value));
        } 
        else if (patriciaKey.toHex().startsWith(codeStorage3)) {
            let pkStorageItem = xxhashAsHex("Staking", 128) + xxhashAsHex("Bonded", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformStakingBonded(fromApi, toApi, patriciaKey, value));
        } 
        
        else {
            return Promise.reject("Fetched data that can not be transformed. PatriciaKey is: " + patriciaKey.toHuman());
        }
    }
}




async function transformContractCodeStorage(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldCodeStorage:  Uint8Array): Promise<StorageItem> {
    let contractStorageCode = fromApi.createType("PrefabWasmModule", scaleOldCodeStorage);
    // let newAccountInfo = await toApi.createType("AccountInfo", [
    //     0, // nonce
    //     0, // consumers
    //     1, // provider
    //     0, // sufficients
    //     [
    //         oldAccountInfo.data.free.toBigInt() + oldAccountInfo.data.reserved.toBigInt(), // free balance
    //         0, // reserved balance
    //         0, // misc frozen balance
    //         0  // free frozen balance
    //     ]
    // ]);

    // if (oldAccountInfo.data.free.toBigInt() + oldAccountInfo.data.reserved.toBigInt()  !== newAccountInfo.data.free.toBigInt()) {
    //     let old = oldAccountInfo.data.free.toBigInt() + oldAccountInfo.data.reserved.toBigInt();
    //     return Promise.reject("Transformation failed. AccountData Balances. (Left: " + old + " vs. " + "Right: " + newAccountInfo.data.free.toBigInt());
    // }

    return new StorageMapValue(contractStorageCode.toU8a(true), completeKey);
}


async function transformContractContractInfoOf(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldContractInfo:  Uint8Array): Promise<StorageItem> {
    console.log("================= transformContractContractInfoOf ================== ");
    
    let contractContractInfoOf = fromApi.createType("MyContractInfo", scaleOldContractInfo).toHuman();
    
    // let newAccountInfo = await toApi.createType("AliveContractInfo", [
    //     contractContractInfoOf['trieId'],
    //     0,
    //     0,
    //     contractContractInfoOf['codeHash'],
    //     0,
    //     0,
    //     0,
    //     0,
    //     contractContractInfoOf['_reserved'],

    // ]);

    // if (oldAccountInfo.data.free.toBigInt() + oldAccountInfo.data.reserved.toBigInt()  !== newAccountInfo.data.free.toBigInt()) {
    //     let old = oldAccountInfo.data.free.toBigInt() + oldAccountInfo.data.reserved.toBigInt();
    //     return Promise.reject("Transformation failed. AccountData Balances. (Left: " + old + " vs. " + "Right: " + newAccountInfo.data.free.toBigInt());
    // }

    //console.log("contractContractInfoOf =====> ", newAccountInfo.toHuman());
    // console.log("completeKey =====> ", completeKey.toHuman());

    return new StorageMapValue(scaleOldContractInfo,completeKey);
    
}



async function transformSystem(
    fromApi: ApiPromise,
    toApi: ApiPromise,
    state: Map<string, Array<StorageItem>>,
    keyValues: Array<[StorageKey, Uint8Array ]>
) {
    // Match against the actual storage items of a pallet.
    for(let [patriciaKey, value] of keyValues) {
        let systemAccount = xxhashAsHex("System", 128) + xxhashAsHex("Account", 128).slice(2);
        if (patriciaKey.toHex().startsWith(systemAccount)) {
            let pkStorageItem = xxhashAsHex("System", 128) + xxhashAsHex("Account", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformSystemAccount(fromApi, toApi, patriciaKey, value));
        } else {
            return Promise.reject("Fetched data that can not be transformed. PatriciaKey is: " + patriciaKey.toHuman());
        }
    }
}

async function transformSystemAccount(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldAccountInfo:  Uint8Array): Promise<StorageItem> {
    let oldAccountInfo = fromApi.createType("AccountInfo", scaleOldAccountInfo);
    
    let newAccountInfo = await toApi.createType("AccountInfo", [
        0, // nonce
        0, // consumers
        1, // provider
        0, // sufficients
        [
            oldAccountInfo.data.free.toBigInt() + oldAccountInfo.data.reserved.toBigInt(), // free balance
            0, // reserved balance
            0, // misc frozen balance
            0  // free frozen balance
        ]
    ]);

    if (oldAccountInfo.data.free.toBigInt() + oldAccountInfo.data.reserved.toBigInt()  !== newAccountInfo.data.free.toBigInt()) {
        let old = oldAccountInfo.data.free.toBigInt() + oldAccountInfo.data.reserved.toBigInt();
        return Promise.reject("Transformation failed. AccountData Balances. (Left: " + old + " vs. " + "Right: " + newAccountInfo.data.free.toBigInt());
    }

    return new StorageMapValue(newAccountInfo.toU8a(true), completeKey);
}

async function transformBalances(
    fromApi: ApiPromise,
    toApi: ApiPromise,
    state: Map<string, Array<StorageItem>>,
    keyValues: Array<[StorageKey,  Uint8Array]>
) {
    for(let [patriciaKey, value] of keyValues) {
        if (patriciaKey.toHex().startsWith(xxhashAsHex("Balances", 128) + xxhashAsHex("TotalIssuance", 128).slice(2))) {
            let pkStorageItem = xxhashAsHex("Balances", 128) + xxhashAsHex("TotalIssuance", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformBalancesTotalIssuance(fromApi, toApi, patriciaKey, value));
        } else if (patriciaKey.toHex().startsWith(xxhashAsHex("Balances", 128) + xxhashAsHex("Locks", 128).slice(2))){
            let pkStorageItem = xxhashAsHex("Balances", 128) + xxhashAsHex("Locks", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformBalancesLocks(fromApi, toApi, patriciaKey, value));
        }
         else {
            return Promise.reject("Fetched data that can not be transformed. Part of Balances. PatriciaKey is: " + patriciaKey.toHex());
        }
    }
}

async function transformBalancesTotalIssuance(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldTotalIssuance:  Uint8Array): Promise<StorageItem> {
    let oldIssuance = fromApi.createType("Balance", scaleOldTotalIssuance);
    let newIssuance = toApi.createType("Balance", oldIssuance.toU8a(true));

    if (oldIssuance.toBigInt() !== newIssuance.toBigInt()) {
        return Promise.reject("Transformation failed. TotalIssuance. (Left: " + oldIssuance.toJSON() + " vs. " + "Right: " + newIssuance.toJSON());
    }

    return new StorageValueValue(newIssuance.toU8a(true));
}

async function transformBalancesLocks(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldBalanceLocks:  Uint8Array): Promise<StorageItem> {
    let oldBalanceLock = fromApi.createType("Balance", scaleOldBalanceLocks);

    //onsole.log("========oldBalanceLocks==========", oldBalanceLock.toHuman());    
    
    // let newBalanceLock = await toApi.createType("BalanceLock", [
    //     oldBalanceLock.id,
    //     oldBalanceLock.amount,
    //     oldBalanceLock.reasons,
    // ]);
    let newBalanceLock = toApi.createType("Balance", oldBalanceLock.toU8a(true));

    if (oldBalanceLock.toBigInt() !== newBalanceLock.toBigInt()) {
       // let old = oldBalanceLock.toBigInt();
        return Promise.reject("Transformation failed. AccountData Balances. (Left: " + oldBalanceLock.toJSON() + " vs. " + "Right: " + newBalanceLock.toBigInt());
    }

    return new StorageMapValue(scaleOldBalanceLocks, completeKey);
}



async function transformStakingLedger(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldStakingLedger:  Uint8Array): Promise<StorageItem> {
    let oldStakingLedger = fromApi.createType("StakingLedger", scaleOldStakingLedger);

    console.log("oldStakingLedger ========> ", oldStakingLedger);

    let newStakingLedger = await toApi.createType("StakingLedger", [
        oldStakingLedger.stash,
        oldStakingLedger.total,
        oldStakingLedger.active,
        oldStakingLedger.unlocking,
        oldStakingLedger.claimedRewards,
    ]);
    if (oldStakingLedger.stash.toString() !== newStakingLedger.stash.toString()) {
        let old = oldStakingLedger.stash.toString();
        return Promise.reject("Transformation failed. AccountData stash. (Left: " + old + " vs. " + "Right: " + newStakingLedger.stash.toString());
    }
    else if (oldStakingLedger.total.toBigInt() !== newStakingLedger.total.toBigInt()) {
        let old = oldStakingLedger.total.toBigInt();
        return Promise.reject("Transformation failed. AccountData total. (Left: " + old + " vs. " + "Right: " + newStakingLedger.total.toBigInt());
    }
    else if (oldStakingLedger.active.toBigInt() !== newStakingLedger.active.toBigInt()) {
        let old = oldStakingLedger.active.toBigInt();
        return Promise.reject("Transformation failed. AccountData active. (Left: " + old + " vs. " + "Right: " + newStakingLedger.active.toBigInt());
    }
    else if (oldStakingLedger.unlocking.toRawType() !== newStakingLedger.unlocking.toRawType()) {
        let old = oldStakingLedger.unlocking.toRawType();
        return Promise.reject("Transformation failed. AccountData unlocking. (Left: " + old + " vs. " + "Right: " + newStakingLedger.unlocking.toRawType());
    }
    else if (oldStakingLedger.claimedRewards.toRawType() !== newStakingLedger.claimedRewards.toRawType()) {
        let old = oldStakingLedger.claimedRewards.toRawType();
        return Promise.reject("Transformation failed. AccountData claimedRewards. (Left: " + old + " vs. " + "Right: " + newStakingLedger.claimedRewards.toRawType());
    }
    else
    {
        console.log("Thanks");
    }

    let a = newStakingLedger.toU8a(true);
    console.log( "a ============> ", a);
    console.log( "b ============> ", oldStakingLedger.toU8a(true));
    console.log( "scaleOldStakingLedger ====> ", scaleOldStakingLedger);

    // return new StorageMapValue(newStakingLedger.toU8a(true), completeKey);
    return new StorageMapValue(scaleOldStakingLedger, completeKey);
}


async function transformStakingValidatorCount(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldStakingValidatorCount:  Uint8Array): Promise<StorageItem> {
    let oldStakingValidatorCount = fromApi.createType("ValidatorCount", scaleOldStakingValidatorCount);

    
    let newStakingValidatorCount = toApi.createType("ValidatorCount", oldStakingValidatorCount.toU8a(true));

    if (oldStakingValidatorCount.toBigInt() !== newStakingValidatorCount.toBigInt()) {
       
        return Promise.reject("Transformation failed. AccountData StakingValidatorCount. (Left: " + oldStakingValidatorCount.toJSON() + " vs. " + "Right: " + newStakingValidatorCount.toBigInt());
    }

    return new StorageValueValue(newStakingValidatorCount.toU8a(true));
}

async function transformStakingBonded(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldStakingBonded:  Uint8Array): Promise<StorageItem> {
    let oldStakingBonded = fromApi.createType("AccountId", scaleOldStakingBonded);

    //onsole.log("========oldBalanceLocks==========", oldBalanceLock.toHuman());    
    
    // let newBalanceLock = await toApi.createType("BalanceLock", [
    //     oldBalanceLock.id,
    //     oldBalanceLock.amount,
    //     oldBalanceLock.reasons,
    // ]);
    let newStakingBonded = toApi.createType("AccountId", oldStakingBonded.toU8a(true));

    if (oldStakingBonded.toString() !== newStakingBonded.toString()) {
       // let old = oldBalanceLock.toBigInt();
        return Promise.reject("Transformation failed. AccountData Balances. (Left: " + oldStakingBonded.toString() + " vs. " + "Right: " + newStakingBonded.toString());
    }

    return new StorageMapValue(scaleOldStakingBonded, completeKey);
}




// async function transformStakingValidator(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldStakingValidator:  Uint8Array): Promise<StorageItem> {
//     let oldStakingValidator = fromApi.createType("ValidatorPrefsWithBlocked", scaleOldStakingValidator);

//     console.log("oldStakingValidator ========> ", oldStakingValidator);

//     let newStakingValidator = await toApi.createType("ValidatorPrefsWithBlocked", [
//         oldStakingValidator.commission,
//         oldStakingValidator.blocked,
//     ]);
//     if (oldStakingValidator.commission.toBigInt() !== newStakingValidator.commission.toBigInt()) {
//         let old = oldStakingValidator.commission.toBigInt();
//         return Promise.reject("Transformation failed. AccountData commission. (Left: " + old + " vs. " + "Right: " + newStakingValidator.commission.toString());
//     }
//     else if (oldStakingValidator.blocked.toU8a() !== newStakingValidator.blocked.toU8a()) {
//         let old = oldStakingValidator.blocked.toU8a();
//         return Promise.reject("Transformation failed. AccountData blocked. (Left: " + old + " vs. " + "Right: " + newStakingValidator.blocked.toBigInt());
//     }
//     else
//     {
//         console.log("Thanks");
//     }

//     let a = newStakingValidator.toU8a(true);
//     console.log( "a ============> ", a);
//     console.log( "b ============> ", oldStakingValidator.toU8a(true));
//     console.log( "scaleOldStakingValidator ====> ", scaleOldStakingValidator);

//     // return new StorageMapValue(newStakingLedger.toU8a(true), completeKey);
//     return new StorageMapValue(scaleOldStakingValidator, completeKey);
// }



















async function transformVesting(
    fromApi: ApiPromise,
    toApi: ApiPromise,
    state: Map<string, Array<StorageItem>>,
    keyValues: Array<[StorageKey,  Uint8Array]>,
    atFrom: Hash,
    atTo: Hash
) {
    const atToAsNumber = (await toApi.rpc.chain.getBlock(atTo)).block.header.number.toBigInt();
    const atFromAsNumber =  (await fromApi.rpc.chain.getBlock(atFrom)).block.header.number.toBigInt();


    for(let [patriciaKey, value] of keyValues) {
        if (patriciaKey.toHex().startsWith(xxhashAsHex("Vesting", 128) + xxhashAsHex("Vesting", 128).slice(2))) {
            let pkStorageItem = xxhashAsHex("Vesting", 128) + xxhashAsHex("Vesting", 128).slice(2);
            await insertOrNewArray(state, pkStorageItem, await transformVestingVestingInfo(fromApi, toApi, patriciaKey, value, atFromAsNumber, atToAsNumber));

        } else {
            return Promise.reject("Fetched data that can not be transformed. PatriciaKey is: " + patriciaKey.toHuman());
        }
    }
}

async function transformVestingVestingInfo(fromApi: ApiPromise, toApi: ApiPromise, completeKey: StorageKey, scaleOldVestingInfo:  Uint8Array, atFrom: bigint, atTo: bigint): Promise<StorageItem> {
    let old = fromApi.createType("VestingInfo", scaleOldVestingInfo);

    let remainingLocked;
    let newPerBlock;
    let newStartingBlock;

    const blockPeriodOldVesting = (old.locked.toBigInt() / old.perBlock.toBigInt());
    const blocksPassedSinceVestingStart = (atFrom - old.startingBlock.toBigInt());

    // We need to check if vesting is ongoing, is finished or has not yet started, as conversion will be different.
    if (blocksPassedSinceVestingStart > 0 && (blockPeriodOldVesting - blocksPassedSinceVestingStart) > 0) {
        // This defines the remaining blocks one must wait until his
        // vesting is over.
        //
        // Details:
        // * (locked/per_block): Number blocks on mainnet overall
        // * snapshot_block - starting_block: Number of vested blocks
        // * subtraction of the above two: How many blocks remain
        let remainingBlocks = (blockPeriodOldVesting - blocksPassedSinceVestingStart);
        // This defines the remaining locked amount. Same as if a person has called vest once at the snapshot block.
        remainingLocked = old.locked.toBigInt() - (blocksPassedSinceVestingStart * old.perBlock.toBigInt());
        // Ensure remaining locked is greater zero
        if (remainingLocked === BigInt(0)) {
            remainingLocked = BigInt(1);
        }
        // * Multiplication by two: Take into account 12s block time
        newPerBlock = (remainingLocked / remainingBlocks) * BigInt(2);
        // Ensure remaining locked is greater zero
        // If we are here, this must be checked manually...
        if (newPerBlock === BigInt(0)) {
            const info = toApi.createType("VestingInfo", [remainingLocked, newPerBlock, atTo]);
            throw Error("Invalid vesting schedule. \nStorageKey: " + completeKey.toHex() + "\n VestingInfo: " + info.toHuman());
        }
        newStartingBlock = atTo;

    } else if ((blockPeriodOldVesting - blocksPassedSinceVestingStart) <= 0 ) {
        // If vesting is finished -> use same start block and give everything at first block
        remainingLocked = old.locked.toBigInt();
        newPerBlock = old.locked.toBigInt();
        newStartingBlock = atTo;

    } else if ((old.startingBlock.toBigInt() - atFrom) >= 0){
        // If vesting has not started yes -> use starting block as (old - blocks_passed_on_old_mainnet) / 2 and multiply per block by 2 to take into account
        // 12s block time.
        remainingLocked = old.locked.toBigInt();
        newPerBlock = old.perBlock.toBigInt() * BigInt(2);
        newStartingBlock = ((old.startingBlock.toBigInt() - atFrom) / BigInt(2)) + atTo;

    } else {
        throw Error("Unreachable code... Came here with old vesting info of: " + old.toHuman());
    }

    let newVesting = await toApi.createType("VestingInfo", [remainingLocked, newPerBlock, newStartingBlock]);

    return new StorageMapValue(newVesting.toU8a(true), completeKey);
}
