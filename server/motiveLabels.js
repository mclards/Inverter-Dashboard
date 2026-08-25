"use strict";

/**
 * Canonical MOTIVO_PARO labels — Slice B of v2.10.0.
 *
 * 30 stop-motive labels (slots 0..29) plus a TOTAL aggregator at slot 30.
 * Slots map directly to ARRAYHISTMOTPARO counter positions, which means
 * `inverter_stop_histogram.counters_json[N]` = lifetime count of times
 * `MOTIVO_PARO_LABELS[N]` has fired.
 *
 * Labels were extracted from the ISM "Stop Reasons" window on 2026-04-27.
 *
 * Note: the StopReason struct's MotParo field (idx 13) is a parallel
 * primary-cause code and does NOT index into this array directly. A
 * motparo_code → MOTIVO_PARO_* mapping is deferred to v2.10.x.
 */

const MOTIVO_PARO_LABELS = Object.freeze([
  "MOTIVO_PARO_VIN",              // 0
  "MOTIVO_PARO_FRED",             // 1
  "MOTIVO_PARO_VRED",             // 2
  "MOTIVO_PARO_VARISTORES",       // 3
  "MOTIVO_PARO_AISL_DC",          // 4
  "MOTIVO_PARO_IAC_EFICAZ",       // 5
  "MOTIVO_PARO_TEMPERATURA",      // 6
  "MOTIVO_PARO_01",               // 7
  "MOTIVO_PARO_CONFIGURACION",    // 8
  "MOTIVO_PARO_MANUAL",           // 9
  "MOTIVO_PARO_BAJA_VPV_MED",     // 10
  "MOTIVO_PARO_HW_DESCX2",        // 11
  "MOTIVO_PARO_FRAMA3",           // 12
  "MOTIVO_PARO_MAX_IAC_INST",     // 13
  "MOTIVO_PARO_CARGA_FIRMWARE",   // 14
  "MOTIVO_PARO_03",               // 15
  "MOTIVO_PARO_04",               // 16
  "MOTIVO_PARO_ERROR_LEC_ADC",    // 17
  "MOTIVO_PARO_CONSUMO_POTENCIA", // 18
  "MOTIVO_PARO_FUS_DC",           // 19
  "MOTIVO_PARO_TEMP_AUX",         // 20
  "MOTIVO_PARO_DES_AC",           // 21
  "MOTIVO_PARO_MAGNETO",          // 22
  "MOTIVO_PARO_CONTACTOR",        // 23
  "MOTIVO_PARO_RESET_WD",         // 24
  "MOTIVO_PARO_PI_ANA_SAT",       // 25
  "MOTIVO_PARO_LATENCIA_ADC",     // 26
  "MOTIVO_PARO_ERROR_FATAL",      // 27
  "MOTIVO_PARO_FRAMA1",           // 28
  "MOTIVO_PARO_FRAMA2",           // 29
  "TOTAL",                        // 30
]);

// v2.10.4 — plain-English description for each Ingeteam stop motive.
// The Spanish codes above stay as-is (they're vendor protocol identifiers
// referenced in INGECON service manuals); these descriptions render
// alongside in the UI so operators don't need to translate in their head.
// Sources: Ingeteam INGECON SUN service documentation +
// `audits/2026-04-27/motivo-paro-decode.md`.
const MOTIVO_PARO_ENGLISH = Object.freeze([
  "Input voltage (DC)",                  // 0   VIN
  "Grid frequency out of band",          // 1   FRED
  "Grid voltage out of band",            // 2   VRED
  "Surge protector (varistors)",         // 3   VARISTORES
  "DC insulation fault",                 // 4   AISL_DC
  "AC current RMS exceeded",             // 5   IAC_EFICAZ
  "Temperature trip",                    // 6   TEMPERATURA
  "Reserved (vendor)",                   // 7   01
  "Configuration error",                 // 8   CONFIGURACION
  "Manual stop (operator)",              // 9   MANUAL
  "Low PV voltage (averaged)",           // 10  BAJA_VPV_MED
  "Hardware discharge ×2",               // 11  HW_DESCX2
  "Frame error 3 (vendor protocol)",     // 12  FRAMA3
  "Max AC current (instantaneous)",      // 13  MAX_IAC_INST
  "Firmware load fault",                 // 14  CARGA_FIRMWARE
  "Reserved (vendor)",                   // 15  03
  "Reserved (vendor)",                   // 16  04
  "ADC read error",                      // 17  ERROR_LEC_ADC
  "Power consumption fault",             // 18  CONSUMO_POTENCIA
  "DC fuse blown",                       // 19  FUS_DC
  "Auxiliary temperature trip",          // 20  TEMP_AUX
  "AC disconnect",                       // 21  DES_AC
  "Magnetothermal breaker tripped",      // 22  MAGNETO
  "Contactor fault",                     // 23  CONTACTOR
  "Watchdog reset",                      // 24  RESET_WD
  "PI controller analog saturation",     // 25  PI_ANA_SAT
  "ADC latency fault",                   // 26  LATENCIA_ADC
  "Fatal error",                         // 27  ERROR_FATAL
  "Frame error 1 (vendor protocol)",     // 28  FRAMA1
  "Frame error 2 (vendor protocol)",     // 29  FRAMA2
  "TOTAL",                               // 30
]);

const TOTAL_INDEX = 30;
const MOTIVE_COUNT = 30;
const TOTAL_LABEL = "TOTAL";

function lookupMotiveLabel(idx) {
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= MOTIVO_PARO_LABELS.length) {
    return `<unknown_${idx}>`;
  }
  return MOTIVO_PARO_LABELS[i];
}

// v2.10.4 — English-language description lookup. Pairs with
// lookupMotiveLabel() so UIs can render "VENDOR_CODE — plain English"
// without each caller embedding their own translation table.
function lookupMotiveDescription(idx) {
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= MOTIVO_PARO_ENGLISH.length) {
    return "";
  }
  return MOTIVO_PARO_ENGLISH[i];
}

/**
 * Decorate a 31-counter array with labels for UI consumption.
 * Returns [{idx, label, count, isTotal}, ...] sorted by idx.
 */
function decorateHistogramCounters(counters) {
  if (!Array.isArray(counters)) return [];
  return counters.map((c, idx) => ({
    idx,
    label: lookupMotiveLabel(idx),
    count: Number.isFinite(Number(c)) ? Number(c) : 0,
    isTotal: idx === TOTAL_INDEX,
  }));
}

module.exports = {
  MOTIVO_PARO_LABELS,
  MOTIVO_PARO_ENGLISH,
  TOTAL_INDEX,
  TOTAL_LABEL,
  MOTIVE_COUNT,
  lookupMotiveLabel,
  lookupMotiveDescription,
  decorateHistogramCounters,
};
