'use strict';
/**
 * Static token configuration — mirrors modules/config.py TOKENS_DATA.
 * Contains minimum order sizes, size decimals, and price decimals for each asset.
 *
 * Additional token data is fetched dynamically from the API during runtime
 * (see variational.js loadTokensData).
 */

const TOKENS_DATA = {
  EGLD:      { minSize: 0.03, sizeDecimals: 2, priceDecimals: 5 },
  KAS:       { minSize: 4.0,  sizeDecimals: 0, priceDecimals: 5 },
  SYS:       { minSize: 10.0, sizeDecimals: 0, priceDecimals: 5 },
  CFX:       { minSize: 3.0,  sizeDecimals: 0, priceDecimals: 5 },
  PUFFER:    { minSize: 4.0,  sizeDecimals: 0, priceDecimals: 5 },
  EIGEN:     { minSize: 0.6,  sizeDecimals: 1, priceDecimals: 4 },
  KERNEL:    { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  JUP:       { minSize: 0.7,  sizeDecimals: 1, priceDecimals: 4 },
  CAMP:      { minSize: 35.0, sizeDecimals: 0, priceDecimals: 6 },
  SKY:       { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  SOPHON:    { minSize: 12.0, sizeDecimals: 0, priceDecimals: 6 },
  AXL:       { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  LTC:       { minSize: 0.002,sizeDecimals: 3, priceDecimals: 4 },
  BERA:      { minSize: 0.2,  sizeDecimals: 1, priceDecimals: 4 },
  SKL:       { minSize: 16.0, sizeDecimals: 0, priceDecimals: 6 },
  ZRX:       { minSize: 1.0,  sizeDecimals: 1, priceDecimals: 4 },
  ON:        { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 4 },
  FET:       { minSize: 0.7,  sizeDecimals: 1, priceDecimals: 4 },
  MERL:      { minSize: 3.0,  sizeDecimals: 0, priceDecimals: 5 },
  AAVE:      { minSize: 0.0009, sizeDecimals: 4, priceDecimals: 3 },
  RUNE:      { minSize: 0.3,  sizeDecimals: 1, priceDecimals: 4 },
  AGLD:      { minSize: 0.4,  sizeDecimals: 1, priceDecimals: 4 },
  CELO:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  BREV:      { minSize: 0.8,  sizeDecimals: 1, priceDecimals: 4 },
  FLUX:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  APRO:      { minSize: 0.7,  sizeDecimals: 1, priceDecimals: 4 },
  NEO:       { minSize: 0.04, sizeDecimals: 2, priceDecimals: 5 },
  RARE:      { minSize: 6.0,  sizeDecimals: 0, priceDecimals: 5 },
  NOT:       { minSize: 277.0,sizeDecimals: 0, priceDecimals: 7 },
  MINA:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  AERGO:     { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  RPL:       { minSize: 0.06, sizeDecimals: 2, priceDecimals: 5 },
  DYM:       { minSize: 3.0,  sizeDecimals: 0, priceDecimals: 5 },
  TRX:       { minSize: 0.4,  sizeDecimals: 1, priceDecimals: 4 },
  SUI:       { minSize: 0.2,  sizeDecimals: 1, priceDecimals: 4 },
  NEAR:      { minSize: 0.2,  sizeDecimals: 1, priceDecimals: 4 },
  BNB:       { minSize: 0.0002, sizeDecimals: 4, priceDecimals: 3 },
  HBAR:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  LDO:       { minSize: 0.4,  sizeDecimals: 1, priceDecimals: 4 },
  ICP:       { minSize: 0.05, sizeDecimals: 2, priceDecimals: 5 },
  XRP:       { minSize: 0.08, sizeDecimals: 2, priceDecimals: 5 },
  TIA:       { minSize: 0.4,  sizeDecimals: 1, priceDecimals: 4 },
  IMX:       { minSize: 0.7,  sizeDecimals: 1, priceDecimals: 4 },
  DOT:       { minSize: 0.08, sizeDecimals: 2, priceDecimals: 5 },
  ATOM:      { minSize: 0.05, sizeDecimals: 2, priceDecimals: 5 },
  AVAX:      { minSize: 0.02, sizeDecimals: 2, priceDecimals: 5 },
  INJ:       { minSize: 0.04, sizeDecimals: 2, priceDecimals: 5 },
  ARB:       { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  OP:        { minSize: 0.9,  sizeDecimals: 1, priceDecimals: 4 },
  LINK:      { minSize: 0.02, sizeDecimals: 2, priceDecimals: 5 },
  UNI:       { minSize: 0.03, sizeDecimals: 2, priceDecimals: 5 },
  AERO:      { minSize: 0.4,  sizeDecimals: 1, priceDecimals: 4 },
  CRV:       { minSize: 0.5,  sizeDecimals: 1, priceDecimals: 4 },
  MNT:       { minSize: 0.2,  sizeDecimals: 1, priceDecimals: 4 },
  APT:       { minSize: 0.2,  sizeDecimals: 1, priceDecimals: 4 },
  DOGE:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  ADA:       { minSize: 0.4,  sizeDecimals: 1, priceDecimals: 4 },
  ENS:       { minSize: 0.02, sizeDecimals: 2, priceDecimals: 5 },
  GMX:       { minSize: 0.02, sizeDecimals: 2, priceDecimals: 5 },
  PENDLE:    { minSize: 0.09, sizeDecimals: 2, priceDecimals: 5 },
  TON:       { minSize: 0.08, sizeDecimals: 2, priceDecimals: 5 },
  WIF:       { minSize: 0.6,  sizeDecimals: 1, priceDecimals: 4 },
  GRASS:     { minSize: 0.6,  sizeDecimals: 1, priceDecimals: 4 },
  RENDER:    { minSize: 0.08, sizeDecimals: 2, priceDecimals: 5 },
  GRT:       { minSize: 4.0,  sizeDecimals: 0, priceDecimals: 5 },
  MANA:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  SAND:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  FIL:       { minSize: 0.2,  sizeDecimals: 1, priceDecimals: 4 },
  BLUR:      { minSize: 6.0,  sizeDecimals: 0, priceDecimals: 5 },
  WLD:       { minSize: 0.3,  sizeDecimals: 1, priceDecimals: 4 },
  SEI:       { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  THETA:     { minSize: 0.6,  sizeDecimals: 1, priceDecimals: 4 },
  ANKR:      { minSize: 24.0, sizeDecimals: 0, priceDecimals: 6 },
  APE:       { minSize: 1.0,  sizeDecimals: 1, priceDecimals: 4 },
  SNX:       { minSize: 0.3,  sizeDecimals: 1, priceDecimals: 4 },
  ENA:       { minSize: 1.0,  sizeDecimals: 1, priceDecimals: 4 },
  PYTH:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  VIRTUAL:   { minSize: 0.2,  sizeDecimals: 1, priceDecimals: 4 },
  POPCAT:    { minSize: 3.0,  sizeDecimals: 0, priceDecimals: 5 },
  PNUT:      { minSize: 3.0,  sizeDecimals: 0, priceDecimals: 5 },
  PENGU:     { minSize: 16.0, sizeDecimals: 0, priceDecimals: 6 },
  BRETT:     { minSize: 14.0, sizeDecimals: 0, priceDecimals: 6 },
  POL:       { minSize: 0.9,  sizeDecimals: 1, priceDecimals: 4 },
  RAY:       { minSize: 0.2,  sizeDecimals: 1, priceDecimals: 4 },
  ZK:        { minSize: 6.0,  sizeDecimals: 0, priceDecimals: 5 },
  STRK:      { minSize: 3.0,  sizeDecimals: 0, priceDecimals: 5 },
  ZETA:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  KAVA:      { minSize: 3.0,  sizeDecimals: 0, priceDecimals: 4 },
  FLOW:      { minSize: 3.0,  sizeDecimals: 0, priceDecimals: 5 },
  MORPHO:    { minSize: 0.06, sizeDecimals: 2, priceDecimals: 5 },
  ETC:       { minSize: 0.02, sizeDecimals: 2, priceDecimals: 5 },
  KNC:       { minSize: 0.8,  sizeDecimals: 1, priceDecimals: 4 },
  ONDO:      { minSize: 0.4,  sizeDecimals: 1, priceDecimals: 4 },
  HNT:       { minSize: 0.08, sizeDecimals: 2, priceDecimals: 5 },
  DRIFT:     { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  STX:       { minSize: 0.5,  sizeDecimals: 1, priceDecimals: 4 },
  TRUMP:     { minSize: 0.03, sizeDecimals: 2, priceDecimals: 5 },
  MELANIA:   { minSize: 0.9,  sizeDecimals: 1, priceDecimals: 4 },
  KAITO:     { minSize: 0.4,  sizeDecimals: 1, priceDecimals: 4 },
  IP:        { minSize: 0.1,  sizeDecimals: 2, priceDecimals: 5 },
  AIXBT:     { minSize: 6.0,  sizeDecimals: 0, priceDecimals: 5 },
  HYPE:      { minSize: 0.004,sizeDecimals: 3, priceDecimals: 4 },
  ETH:       { minSize: 0.00006, sizeDecimals: 5, priceDecimals: 2 },
  SOL:       { minSize: 0.002,   sizeDecimals: 3, priceDecimals: 4 },
  BTC:       { minSize: 0.000002, sizeDecimals: 6, priceDecimals: 2 },
  XLM:       { minSize: 0.7,  sizeDecimals: 1, priceDecimals: 4 },
  IOTA:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  ALGO:      { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  TRB:       { minSize: 0.008,sizeDecimals: 3, priceDecimals: 4 },
  ZEC:       { minSize: 0.0005, sizeDecimals: 4, priceDecimals: 3 },
  XMR:       { minSize: 0.0003, sizeDecimals: 4, priceDecimals: 3 },
  COMP:      { minSize: 0.006, sizeDecimals: 3, priceDecimals: 4 },
  YFI:       { minSize: 0.00004, sizeDecimals: 5, priceDecimals: 2 },
  QNT:       { minSize: 0.002, sizeDecimals: 3, priceDecimals: 4 },
  TAO:       { minSize: 0.0006, sizeDecimals: 4, priceDecimals: 3 },
  GNO:       { minSize: 0.0009, sizeDecimals: 4, priceDecimals: 3 },
  XAUT:      { minSize: 0.00002, sizeDecimals: 5, priceDecimals: 2 },
  PAXG:      { minSize: 0.00002, sizeDecimals: 5, priceDecimals: 2 },
  ASTR:      { minSize: 14.0, sizeDecimals: 0, priceDecimals: 6 },
  FARTCOIN:  { minSize: 0.7,  sizeDecimals: 1, priceDecimals: 4 },
  PEAQ:      { minSize: 7.0,  sizeDecimals: 0, priceDecimals: 5 },
  MOVE:      { minSize: 5.0,  sizeDecimals: 0, priceDecimals: 5 },
  USUAL:     { minSize: 8.0,  sizeDecimals: 0, priceDecimals: 5 },
  PEOPLE:    { minSize: 16.0, sizeDecimals: 0, priceDecimals: 6 },
  GOAT:      { minSize: 6.0,  sizeDecimals: 0, priceDecimals: 5 },
  MOODENG:   { minSize: 2.0,  sizeDecimals: 0, priceDecimals: 5 },
  BANANAS31: { minSize: 22.0, sizeDecimals: 0, priceDecimals: 6 },
  COOKIE:    { minSize: 6.0,  sizeDecimals: 0, priceDecimals: 5 },
  // Dynamic tokens are added at runtime by loadTokensData()
};

/** Runtime-added tokens (fetched from the API) */
const RUNTIME_TOKENS = {};

/** Merge and return all token data */
function getAllTokens() {
  return { ...TOKENS_DATA, ...RUNTIME_TOKENS };
}

/** Add a token discovered at runtime */
function addRuntimeToken(name, data) {
  RUNTIME_TOKENS[name] = data;
}

/** Check if token is known */
function hasToken(name) {
  return !!(TOKENS_DATA[name] || RUNTIME_TOKENS[name]);
}

/** Get token data (static + runtime) */
function getToken(name) {
  return TOKENS_DATA[name] || RUNTIME_TOKENS[name] || null;
}

module.exports = { TOKENS_DATA, getAllTokens, addRuntimeToken, hasToken, getToken };
