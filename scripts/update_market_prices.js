/**
 * Multi-Market Waterfall Price Engine for CS2 Unbox Legends
 * Cross-references:
 * 1. Steam Community Market (Liquid items)
 * 2. CSFloat (High-tier & $2k+ items)
 * 3. BUFF163 (Global cash liquidity)
 * 4. Skinport (European cash market)
 * 5. Historical Fallback Archive
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

function fetchGzipJson(url) {
    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, res => {
            if (res.statusCode !== 200) {
                console.warn("HTTP " + res.statusCode + " from " + url);
                return resolve({});
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                let text;
                try {
                    text = zlib.gunzipSync(buffer).toString('utf-8');
                } catch {
                    text = buffer.toString('utf-8');
                }
                try {
                    resolve(JSON.parse(text));
                } catch (err) {
                    console.warn("JSON parse error for " + url + ": " + err.message);
                    resolve({});
                }
            });
        }).on('error', err => {
            console.warn("Network error for " + url + ": " + err.message);
            resolve({});
        });
    });
}

function normalizeKey(str) {
    return str.toLowerCase()
        .replace(/★/g, '')
        .replace(/\|/g, '')
        .replace(/'/g, '')
        .replace(/-/g, '_')
        .replace(/[()]/g, '')
        .replace(/\s+/g, '_')
        .replace(/__+/g, '_')
        .replace(/^_|_$/g, '');
}

const VALID_WEAPON_NAMES = [
    'AK-47', 'M4A4', 'M4A1-S', 'AWP', 'Desert Eagle', 'USP-S', 'Glock-18',
    'P250', 'Five-SeVeN', 'CZ75-Auto', 'Tec-9', 'Dual Berettas', 'R8 Revolver', 'P2000',
    'FAMAS', 'Galil AR', 'SG 553', 'AUG', 'SSG 08', 'SCAR-20', 'G3SG1',
    'MP9', 'MAC-10', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon',
    'Nova', 'XM1014', 'MAG-7', 'Sawed-Off', 'M249', 'Negev', 'Zeus x27',
    'Knife', 'Bayonet', 'Karambit', 'Daggers', 'Gloves', 'Hand Wraps', 'Case', 'Package', 'Capsule'
];

async function main() {
    console.log('[1/4] Fetching multi-market feeds simultaneously...');
    const [steamData, csfloatData, buffData, skinportData] = await Promise.all([
        fetchGzipJson('https://prices.csgotrader.app/latest/steam.json'),
        fetchGzipJson('https://prices.csgotrader.app/latest/csfloat.json'),
        fetchGzipJson('https://prices.csgotrader.app/latest/buff163.json'),
        fetchGzipJson('https://prices.csgotrader.app/latest/skinport.json')
    ]);

    console.log("Fetched: Steam (" + Object.keys(steamData).length + "), CSFloat (" + Object.keys(csfloatData).length + "), Buff (" + Object.keys(buffData).length + "), Skinport (" + Object.keys(skinportData).length + ")");

    const wearsList = [
        { code: 'FN', suffix: ' (Factory New)' },
        { code: 'MW', suffix: ' (Minimal Wear)' },
        { code: 'FT', suffix: ' (Field-Tested)' },
        { code: 'WW', suffix: ' (Well-Worn)' },
        { code: 'BS', suffix: ' (Battle-Scarred)' }
    ];

    const allMarketHashNames = new Set([
        ...Object.keys(steamData),
        ...Object.keys(csfloatData),
        ...Object.keys(buffData),
        ...Object.keys(skinportData)
    ]);

    function resolveItemPrice(fullName) {
        // Priority 1: Steam Market
        const steamObj = steamData[fullName];
        if (steamObj && typeof steamObj === 'object') {
            const sp = steamObj.last_24h || steamObj.last_7d || steamObj.last_30d || steamObj.last_90d;
            if (sp && typeof sp === 'number' && sp > 0) return { price: sp, source: 'steam', pObj: steamObj };
        }

        // Priority 2: CSFloat
        const csf = csfloatData[fullName];
        if (csf && typeof csf.price === 'number' && csf.price > 0) {
            return { price: csf.price, source: 'csfloat', pObj: null };
        }

        // Priority 3: BUFF163
        const bf = buffData[fullName];
        if (bf) {
            const bp = (bf.starting_at && bf.starting_at.price) || (bf.highest_order && bf.highest_order.price);
            if (bp && typeof bp === 'number' && bp > 0) return { price: bp, source: 'buff', pObj: null };
        }

        // Priority 4: Skinport
        const skp = skinportData[fullName];
        if (skp) {
            const skPrice = skp.starting_at || skp.suggested_price;
            if (skPrice && typeof skPrice === 'number' && skPrice > 0) return { price: skPrice, source: 'skinport', pObj: null };
        }

        return null;
    }

    const grouped = {};

    for (const fullName of allMarketHashNames) {
        if (fullName.startsWith('Sticker |') ||
            fullName.startsWith('Sealed Graffiti |') ||
            fullName.startsWith('Patch |') ||
            fullName.startsWith('Music Kit |') ||
            fullName.startsWith('Collectible |') ||
            fullName.startsWith('Pin |') ||
            fullName.startsWith('Pass |') ||
            fullName.startsWith('Agent |') ||
            fullName.includes('Graffiti |') ||
            fullName.includes('Charm |')) {
            continue;
        }

        const isRelevant = VALID_WEAPON_NAMES.some(w => fullName.includes(w));
        if (!isRelevant) continue;

        const resolved = resolveItemPrice(fullName);
        if (!resolved || resolved.price <= 0) continue;

        let baseName = fullName;
        let wearCode = 'FT';

        for (const w of wearsList) {
            if (fullName.endsWith(w.suffix)) {
                baseName = fullName.substring(0, fullName.length - w.suffix.length).trim();
                wearCode = w.code;
                break;
            }
        }

        const isStatTrak = baseName.startsWith('StatTrak™ ');
        const isSouvenir = baseName.startsWith('Souvenir ');
        const cleanBase = baseName.replace(/^StatTrak™\s+/, '').replace(/^Souvenir\s+/, '').trim();

        if (!grouped[cleanBase]) {
            grouped[cleanBase] = {
                cleanBase,
                wears: {},
                stWears: {},
                priceObj: null
            };
        }

        if (isStatTrak) {
            grouped[cleanBase].stWears[wearCode] = resolved.price;
        } else if (!isSouvenir) {
            grouped[cleanBase].wears[wearCode] = resolved.price;
            if (wearCode === 'FT' || !grouped[cleanBase].priceObj) {
                grouped[cleanBase].priceObj = resolved.pObj;
            }
        }
    }

    console.log("[2/4] Consolidating " + Object.keys(grouped).length + " weapons and high-tier collector items...");
    const result = {};

    for (const [baseName, itemData] of Object.entries(grouped)) {
        const wears = itemData.wears;
        const stWears = itemData.stWears;
        
        const ftPrice = wears.FT || wears.MW || wears.WW || wears.BS || wears.FN || 1.0;
        
        const completeWears = {
            FN: Math.max(0.03, wears.FN || Math.round(ftPrice * 2.2 * 100) / 100),
            MW: Math.max(0.03, wears.MW || Math.round(ftPrice * 1.35 * 100) / 100),
            FT: Math.max(0.03, wears.FT || ftPrice),
            WW: Math.max(0.03, wears.WW || Math.round(ftPrice * 0.88 * 100) / 100),
            BS: Math.max(0.03, wears.BS || Math.round(ftPrice * 0.75 * 100) / 100)
        };

        let stMult = 1.75;
        if (stWears.FT && wears.FT) {
            stMult = Math.round((stWears.FT / wears.FT) * 100) / 100;
        } else if (stWears.FN && wears.FN) {
            stMult = Math.round((stWears.FN / wears.FN) * 100) / 100;
        }

        const pObj = itemData.priceObj || {};
        const p24h = pObj.last_24h || ftPrice;
        const p7d = pObj.last_7d || p24h;
        const p30d = pObj.last_30d || p7d;
        const p90d = pObj.last_90d || p30d;

        const change24h = p7d > 0 ? Math.round(((p24h - p7d) / p7d) * 1000) / 10 : 0.0;

        const hist = [
            Math.round(p90d * 100) / 100,
            Math.round(((p90d + p30d) / 2) * 100) / 100,
            Math.round(p30d * 100) / 100,
            Math.round(((p30d + p7d) / 2) * 100) / 100,
            Math.round(p7d * 100) / 100,
            Math.round(((p7d + p24h) / 2) * 100) / 100,
            Math.round(p24h * 100) / 100
        ];

        const itemEntry = {
            market_hash_name: baseName + " (Field-Tested)",
            current_price_usd: completeWears.FT,
            price_change_24h_percent: change24h,
            historical_7d_prices: hist,
            wears: completeWears,
            stattrak_multiplier: stMult
        };

        const key = normalizeKey(baseName);
        result[key] = itemEntry;

        const aliases = new Set();
        aliases.add(key.replace(/m4a1_s_/, 'm4a1s_'));
        aliases.add(key.replace(/m4a1s_/, 'm4a1_s_'));
        aliases.add(key.replace(/ak_47_/, 'ak47_'));
        aliases.add(key.replace(/ak47_/, 'ak_47_'));
        aliases.add(key.replace(/glock_18_/, 'glock18_'));
        aliases.add(key.replace(/glock_18_/, 'glock_'));
        aliases.add(key.replace(/desert_eagle_/, 'deagle_'));
        aliases.add(key.replace(/knife_/, ''));
        aliases.add('knife_' + key);
        aliases.add(key.replace(/gloves_/, ''));
        aliases.add('gloves_' + key);

        for (const alias of aliases) {
            if (alias && alias !== key && !result[alias]) {
                result[alias] = itemEntry;
            }
        }
    }

    // Add cases
    for (const fullName of allMarketHashNames) {
        if (fullName.includes('Case') || fullName.includes('Capsule') || fullName.includes('Package')) {
            const resolved = resolveItemPrice(fullName);
            if (resolved && resolved.price > 0) {
                const key = normalizeKey(fullName);
                const caseEntry = {
                    market_hash_name: fullName,
                    current_price_usd: Math.round(resolved.price * 100) / 100,
                    price_change_24h_percent: 0.5,
                    historical_7d_prices: [resolved.price, resolved.price, resolved.price, resolved.price, resolved.price, resolved.price, resolved.price],
                    wears: { FN: resolved.price, MW: resolved.price, FT: resolved.price, WW: resolved.price, BS: resolved.price },
                    stattrak_multiplier: 1.0
                };
                result[key] = caseEntry;
                result['case_' + key] = caseEntry;
            }
        }
    }

    // Fallback Merge with existing prices_v1.json
    const outputPath = path.join(__dirname, '../prices_v1.json');
    if (fs.existsSync(outputPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
            for (const [oldKey, oldVal] of Object.entries(existing)) {
                if (!result[oldKey]) result[oldKey] = oldVal;
            }
        } catch (e) {
            console.warn('Could not read existing file for merge: ' + e.message);
        }
    }

    const finalCount = Object.keys(result).length;
    if (finalCount < 500) {
        throw new Error("Sanity check failed: output only has " + finalCount + " items. Refusing to write.");
    }

    console.log("[3/4] Multi-market dataset ready with " + finalCount + " items!");
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    console.log("[4/4] Saved " + outputPath + " (" + Math.round(fs.statSync(outputPath).size / 1024) + " KB)");
}

main().catch(err => {
    console.error('[Fatal Error]', err.message);
    process.exit(1);
});
