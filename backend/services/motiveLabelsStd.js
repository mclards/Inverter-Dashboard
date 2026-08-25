"use strict";

/**
 * Slice ε — canonical motive code lookup table (30-entry mapping)
 *
 * Per Ingeteam INGECON SUN Modbus RTU specification:
 *   docs/IngeconSunPMax-Modbus-pg07.txt
 *   docs/IngeconSunPMax-Modbus-pg08.txt
 *
 * This table is the single source of truth for motive-code display names.
 * Python services/inverter_engine.py embeds an equivalent dict inline
 * in _get_motive_label() for self-containedness — both must stay in sync.
 *
 * Related plan: plans/slice-epsilon-implementation.md §4
 */

const MOTIVE_LABELS_STD = {
  0: "MOTIVO_PARO_NONE",              // No fault / empty slot
  1: "MOTIVO_PARO_VIN",               // Input voltage very high (DC overvoltage)
  2: "MOTIVO_PARO_FRED",              // Grid frequency out of range (AC frequency deviation)
  3: "MOTIVO_PARO_VRED",              // Grid voltage out of range (AC voltage deviation)
  4: "MOTIVO_PARO_VARISTORES",        // Failure in protection varistors (hardware protection trip)
  5: "MOTIVO_PARO_AISL_DC",           // Isolation failure in solar field (ground fault detection)
  6: "MOTIVO_PARO_IAC_EFICAZ",        // RMS output current higher than limit (overcurrent RMS)
  7: "MOTIVO_PARO_TEMPERATURA",       // Stop because of high temperature (thermal shutdown)
  8: "MOTIVO_PARO_LATENCIA_SPI",      // Communication error in SPI bus (internal DSP fault)
  9: "MOTIVO_PARO_CONFIGURACION",     // Stop because of configuration change (parameter update shutdown)
  10: "MOTIVO_PARO_PARO_MANUAL",      // Manual stop inverter (operator shutdown)
  11: "MOTIVO_PARO_BAJA_VPV_MED",     // Stop due to low voltage in solar field (DC undervoltage)
  12: "MOTIVO_PARO_HW_DESCX2",        // Hardware error (NOT IN USE / deprecated)
  13: "MOTIVO_PARO_FRAMA3",           // Failure in branch 3 (power electronics branch 3 fault)
  14: "MOTIVO_PARO_MAX_IAC_INST",     // Instantaneous output current higher (overcurrent instantaneous)
  15: "MOTIVO_PARO_CARGA_FIRMWARE",   // Stop by firmware load (firmware update in progress)
  16: "MOTIVO_PARO_REDUNDANTE",       // Error from redundant DSP (redundancy DSP mismatch)
  17: "MOTIVO_PARO_PROTECCION_PIB",   // Error in PIB protection (multistring only)
  18: "MOTIVO_PARO_ERROR_LEC_ADC",    // Internal error in ADC (analog-to-digital converter fault)
  19: "MOTIVO_PARO_CONSUMO_POTENCIA", // Stop due to power consumption (parasitic load trigger)
  20: "MOTIVO_PARO_FUS_DC",           // DC fuses melt (DC fuse blown)
  21: "MOTIVO_PARO_TEMP_AUX",         // Error in temperature auxiliary protection (aux temp threshold exceeded)
  22: "MOTIVO_PARO_PROT_AC",          // Failure in AC controller (AC control circuit fault)
  23: "MOTIVO_PARO_MAGNETO",          // Trigger from thermomagnetic protection (AC disconnect mechanical)
  24: "MOTIVO_PARO_CONTACTOR",        // Error in grid connection contactor (grid contactor stuck / sensing error)
  25: "MOTIVO_PARO_RESET_WD",         // Reset WD from DSP (watchdog timer reset)
  26: "MOTIVO_PARO_PI_ANA_SAT",       // Saturation in current control (current PI loop saturation)
  27: "MOTIVO_PARO_LATENCIA_ADC",     // Latent error in ADC (ADC latency / timing fault)
  28: "MOTIVO_PARO_ERROR_FATAL",      // Fatal error from power electronics (critical PE fault unrecoverable)
  29: "MOTIVO_PARO_FRAMA1",           // Failure in branch 1 (power electronics branch 1 fault)
  30: "MOTIVO_PARO_FRAMA2",           // Failure in branch 2 (power electronics branch 2 fault)
};

/**
 * Get the human-readable label for a motive code.
 * @param {number} code — code 0–30, or edge cases like -1 (offline)
 * @returns {string} Symbol name or "unknown(code)" for undefined codes
 */
function getMotiveLabel(code) {
  const codeNum = parseInt(code, 10);
  if (MOTIVE_LABELS_STD.hasOwnProperty(codeNum)) {
    return MOTIVE_LABELS_STD[codeNum];
  }
  return `unknown(${codeNum})`;
}

module.exports = {
  MOTIVE_LABELS_STD,
  getMotiveLabel,
};
