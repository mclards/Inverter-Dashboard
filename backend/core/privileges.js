"use strict";
/**
 * privileges.js — Role Privileges & Permissions Matrix for ADSI Inverter Dashboard
 * 
 * Strict Invariant: Exactly Two Roles
 * 1. Developer (devClard / dev<MM>) — Master privileges (diagnostics, firmware, tuning, lock override)
 * 2. Operator (admin / 1234) — Operational privileges (SCADA telemetry, APC commands, export, report)
 */

const ROLES = Object.freeze({
  DEVELOPER: "developer",
  OPERATOR: "operator"
});

const PRIVILEGES = Object.freeze({
  [ROLES.DEVELOPER]: Object.freeze({
    roleName: "Developer",
    canViewTelemetry: true,
    canControlInverters: true,
    canConfigurePlantCap: true,
    canRunComplianceTests: true,
    canExportData: true,
    canSyncClocks: true,
    canModifyOperatorCredentials: true,
    canManageFirmware: true,
    canOverrideControlLock: true,
    canAccessDebugDiagnostics: true,
    canModifyServerConfig: true,
    canTuneForecastModel: true
  }),
  [ROLES.OPERATOR]: Object.freeze({
    roleName: "Operator",
    canViewTelemetry: true,
    canControlInverters: true,
    canConfigurePlantCap: true,
    canRunComplianceTests: true,
    canExportData: true,
    canSyncClocks: true,
    canModifyOperatorCredentials: true,
    canManageFirmware: false,
    canOverrideControlLock: false,
    canAccessDebugDiagnostics: false,
    canModifyServerConfig: false,
    canTuneForecastModel: false
  })
});

function getPrivilegesForRole(role) {
  const normalized = String(role || "").toLowerCase().trim();
  if (normalized === ROLES.DEVELOPER) {
    return PRIVILEGES[ROLES.DEVELOPER];
  }
  return PRIVILEGES[ROLES.OPERATOR];
}

module.exports = {
  ROLES,
  PRIVILEGES,
  getPrivilegesForRole
};
