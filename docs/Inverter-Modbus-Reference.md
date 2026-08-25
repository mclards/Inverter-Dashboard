# INGECON SUN PMax — Modbus Register Reference

| Field | Value |
|---|---|
| Inverter family | Ingeteam INGECON SUN PMax three-phase (this site: 27 units, 250 kW each) |
| Source-of-truth | [docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf](IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf) — AAS1000ICB08, Ingeteam Power Technology S.A., 09/01/2013 |
| Implementing plan | [plans/2026-05-10-modbus-registers-official-revamp.md](../plans/2026-05-10-modbus-registers-official-revamp.md) |
| Implementation status | [audits/2026-05-11/modbus-revamp-implementation-status.md](../audits/2026-05-11/modbus-revamp-implementation-status.md) |
| Transport | Modbus TCP via comm-board / EKI-1222-BE gateway → RTU on the inverter side. FC 0x03 / 0x04 / 0x06 / 0x10 in standard use; vendor FC 0x71 SCOPE peek for stop-reason snapshots. |
| Address convention | All addresses in this doc are **0-indexed on-the-wire** (Modbus protocol convention). The PDF uses the human-readable `30001` / `41001` aliases — both are shown side by side. |
| Word order | UInt32 fields are **hi-lo** (high register first, big-endian within each register). |

> **This is a derived reference.** Discrepancies → the source PDF wins. When the PDF and a reverse-engineered packet capture disagree, file an issue and update both this doc and the implementing slice.

---

## 1. Input registers — FC 0x04 (read-only)

### 1.1 Lifetime counters (PDF pg 4)

| Alias | Wire addr | Field | Type | Unit | Notes |
|---|---|---|---|---|---|
| 30001-30002 | 0-1 | `Etotal` | UInt32 hi-lo | kWh | Lifetime energy. Used for crash-recovery seed (v2.9.0). |
| 30003-30004 | 2-3 | `Hours up` | UInt32 hi-lo | hours | Lifetime running hours (not currently captured) |
| 30005-30006 | 4-5 | `Conex` | UInt32 hi-lo | count | Lifetime grid-connection count (not currently captured) |
| 30007-30008 | 6-7 | `Alarmas_Inv` | UInt32 hi-lo | bitfield | Latched alarm bitmap, 16 documented bits — see §5 |

### 1.2 Live AC/DC metrics (PDF pg 4-5)

| Alias | Wire addr | Field | Type | Unit | Notes |
|---|---|---|---|---|---|
| 30009 | 8 | `Vdc` | UInt16 | V | DC bus voltage (1000 Vdc nominal — built-in) |
| 30010 | 9 | `Idc` | **Int16 signed** | A | Sign cast applied since Slice α |
| 30011-30013 | 10-12 | `Vac1/2/3` | UInt16 | V | Per-phase RMS grid voltage |
| 30014-30016 | 13-15 | `Iac1/2/3` | UInt16 | 0.1 A/LSB | Per-phase RMS grid current |
| 30017 | 16 | `CosFi` | UInt16 | thousandths | Cos(φ) × 1000 |
| 30018 | 17 | `SigSinFi` | UInt16 | flag | 0 = positive sin(φ), 1 = negative |
| 30019 | 18 | `PAC` | **Int16 signed** | tens of W | Sign cast applied since Slice α. Negative = importing (theoretical only at this site). |
| 30020 | 19 | `Fac2` | UInt16 | hundredths Hz | **Grid frequency. Site = 60 Hz NGCP envelope** (continuous 59.7-60.3, withstand 58.2-61.8, NOT the European 50 Hz numbers in the PDF). |
| 30021-30026 | 20-25 | RTC | UInt16 ×6 | – | Year / month / day / hour / minute / second; used by clock-sync chain |
| 30027 | 26 | `Pos_grad_solPor10` | UInt16 | degrees ×10 | Sun position (suntracker — not used at this site) |

### 1.3 Suntracker / Analog inputs / Resettable counters (PDF pg 5-6)

| Alias | Wire addr | Field | Status |
|---|---|---|---|
| 30028-30041 | 27-40 | Suntracker 1 & 2 | **Skip** — no trackers on site |
| 30042-30045 | 41-44 | `Analog Input 1-4` | AAP0016 card not installed; decoded into frame, UI behind toggle |
| 30046-30047 | 45-46 | `PT100 #1 / #2` | Same — AAP0016 dependent |
| 30048-30058 | 47-57 | Reserved | – |
| 30059-30060 | 58-59 | `parcE` | UInt32 hi-lo, kWh — partial energy since reset; used for crash-recovery seeding |
| 30061-30062 | 60-61 | Resettable hours | UInt32 hi-lo — not currently captured |
| 30063-30064 | 62-63 | Resettable connection count | UInt32 hi-lo — not currently captured |

### 1.4 Alarm windows (PDF pg 6-7)

| Alias | Wire addr | Field | Reset behaviour |
|---|---|---|---|
| 30065-30066 | 64-65 | Instantaneous alarms (UInt32 hi-lo) | **Resets every 1 s** — captures transient alarms |
| 30067-30068 | 66-67 | Maintained alarms (UInt32 hi-lo) | **Resets on grid reconnection** — mid-session memory |

Both share the same 16-bit bitmap layout as `Alarmas_Inv` at 30007-30008. See §5.

### 1.5 Diagnostic + state (PDF pg 7) — **slow-poll captured (Slice β)**

| Alias | Wire addr | Field | Type | Unit | Notes |
|---|---|---|---|---|---|
| 30069 | 68 | `QAC` | **Int16 signed** | reactive W ÷ 10 | Slow-poll. Negative = leading (capacitive), positive = lagging (inductive). |
| 30070 | 69 | `Zpos` | UInt16 | kΩ | Solar field impedance, POS-EARTH (insulation health) |
| 30071 | 70 | `Zneg` | UInt16 | kΩ | Solar field impedance, NEG-EARTH |
| 30072 | 71 | `TempCI` | **Int16 signed** | °C | Power electronics; -1 ISM-parity offset applied. -14 = NTC fault. |
| 30073 | 72 | `TempINT` | **Int16 signed** | °C | Control electronics; threshold 80 °C. |
| 30074 | 73 | **`Estado`** | UInt16 | bitfield | **Authoritative inverter state** — see §3. |
| 30075 | 74 | `VpvN` | UInt16 | V | Solar field voltage NEG-EARTH (insulation diagnostic) |
| 30076 | 75 | `VpvP` | UInt16 | V | Solar field voltage POS-EARTH |
| 30077 | 76 | Nominal power ÷ 10 | UInt16 | tens of W | **Rated power as reported by device.** Cross-checked against operator-configured `NODE_KW_MAX` — drift > 5 % emits `nominal_power_mismatch` audit row (Slice β-4). |

### 1.6 Stop-reason history (standard Modbus) (PDF pg 7-8)

| Alias | Wire addr | Field | Notes |
|---|---|---|---|
| 30078 | 77 | Pos. last stop reason (0-4) | Index of newest entry in 5-slot ring buffer |
| 30079-30084 | 78-83 | Stop reason 0: year / month / day / hour / minute / motive | 30 motive codes documented (PDF pg 7-8) |
| 30085-30090 | 84-89 | Stop reason 1 | – |
| 30091-30096 | 90-95 | Stop reason 2 | – |
| 30097-30102 | 96-101 | Stop reason 3 | – |
| 30103-30108 | 102-107 | Stop reason 4 | – |

**Cross-check with vendor SCOPE peek:** the standard-Modbus history exposes `(timestamp, motive_code)` only. The vendor SCOPE peek ([services/stop_reason.py](../services/stop_reason.py)) adds `Vpv`, `Iac1/2`, `Frec1/2/3`, `Cos`, `Temp`, `Alarma` snapshot, plus the `DebugDesc` vendor sub-code. Both run in parallel since Slice ε.

### 1.7 Connection countdown / MS mirrors / curtailment (PDF pg 8-9)

| Alias | Wire addr | Field | Notes |
|---|---|---|---|
| 30109 | 108 | Remaining seconds to grid connection | Useful UI signal — "starting in 47 s" |
| 30110 | 109 | Total seconds to connect | Configured island-connection timeout |
| 30111-30115 | 110-114 | Mirrors of state / cos / sin / power / qac | **Skip** — only meaningful in master-slave installations; not deployed on this fleet |
| 30116 | 115 | 1000 V kit usage counter | Decoded but not surfaced — built-in to PMax design here |
| 30117 | 116 | **`Power reduction register`** | **Critical APC feedback bitfield.** See §4. |

---

## 2. Holding registers — FC 0x10 (write) / FC 0x03 (read)

| Alias | Wire addr | Field | RW | Notes |
|---|---|---|---|---|
| 41001 | 1000 (0x03E8) | Command code | RW | Range 0-14 (PDF table says 0-12 but 13/14 documented) |
| 41002 | 1001 | Command data | RW | Per-command meaning |
| 41003-41005 | 1002-1004 | Reserved | R | – |
| 41006 | 1005 | **Power reduction target** | R | Q15: 0 = 0 %, 32767 = 100 %. **Read-back of last cmd-3 setpoint.** |
| 41007 | 1006 | **Phi tangent target** | R | Int16, ±15729 |
| 41008 | 1007 | **Reactive target** | R | Int16, ±32767 |
| 41009 | 1008 | Reserved | R | – |
| 41010 | 1009 | **Restrictive freq limits** | R | 0 = OFF (47.5/51.5 Hz), 1 = ON (49.5/50.5 Hz, CEI 0-21) |
| 41011-41012 | 1010-1011 | Reserved | R | – |

### 2.1 Reference / baseline setpoint storage

The dashboard treats **runtime reference setpoints** and **persistent firmware
configuration** as two distinct layers. Both are documented; only the runtime
layer is read live.

| Layer | What | Where stored | Survives power cycle? | Live-read | Authoritative tool |
|---|---|---|---|---|---|
| **L1 — Runtime reference** | Most-recent commanded setpoint per axis (active power Q15, phi tangent, reactive kVAr) | Holding regs **41006 / 41007 / 41008** | Yes (registers persist until next write or reset) | Yes — `read_grid_control_state` ([services/inverter_engine.py:3558](../services/inverter_engine.py#L3558)) reads all five 41006-41010 in one FC 0x03 transaction every time the Grid Code → Read-back panel asks. Slice ζ verifier ([server/gridControlVerifier.js](../server/gridControlVerifier.js)) round-trips L1 within ~10 s of every cmd-1/9/11 write. | Dashboard (Plant Controller → Grid Code) |
| **L2 — Persistent firmware config** | Full holding-register snapshot (177 UInt16): commissioning-time alarm thresholds, country-code envelope, frequency limits, ramp defaults, isolation thresholds, etc. | Inverter NVRAM, exported by ISM as `*.INGECONsettings` XML | Yes — only ISM commissioning workflow rewrites it | **No.** The dashboard does NOT read or write L2. | INGECON SUN Manager (vendor tool) |

L1 verification (the dashboard does this) confirms the *most recent command* landed — it cannot confirm the underlying L2 envelope is correct. Conversely, L2 audit (operator's responsibility, via ISM) confirms the inverter is configured per NGCP Country Code 42 but cannot detect transient L1 drift between commands.

**Example traceability** — a Set kVAr write at 14:23 produces:
1. Audit row `grid_control.reactive_set` (Node) at `audit_log`
2. Holding reg **41008** updated to the new Int16 raw value
3. `gridControlVerifier` schedules a delayed read of 41008 → row in `grid_control_verify_log` with `result = ok / mismatch / no_response / timeout`
4. Subsequent live observation in input reg **30069** (QAC actual) shows the inverter is now sourcing/sinking the commanded VAr

Sample L2 reference for this fleet: [docs/400152914R81.INGECONsettings](400152914R81.INGECONsettings) (serial 400152914R81, firmware AAV1003BA, exported 2026-05-10 by ISM). The HEXSETTINGS blob is the canonical baseline a healthy unit on this site should match within ±tolerances.

---

## 3. Inverter state register (reg 30074) — Slice γ

UInt16 bitfield. Decoded by [`decodeInverterState`](../server/poller.js) into a structured object.

**Low byte (bits 0-7) — phase:**

| Value | Phase |
|---|---|
| 0 | initial |
| 1 | initial-magnetization |
| 2 | grid-connected |
| 3 | error |

**High byte (bits 8-15) — flags:**

| Bit | Meaning |
|---|---|
| 0 | 1 = stop, 0 = run |
| 1 | blocked |
| 2 | grid fault detected |

The decoded chip is rendered unconditionally in the Parameters page. The `useAuthoritativeInverterState` setting ([server/index.js:8266](../server/index.js#L8266), default `"0"`) is reserved for the future Inverter Card status-chip swap.

---

## 4. Power-reduction status (reg 30117) — Slice δ

UInt16 bitfield read on every slow-poll cycle.

| Bit | Meaning |
|---|---|
| 0 | Power limitation **active** (inverter is NOT injecting all available solar power) |
| 1 | **Modbus power reduction on** ← APC write feedback |
| 2 | Max-frequency power reduction on |
| 3 | Grid-fault power reduction on |
| 4 | High-Vdc power reduction on |
| 5 | High-temperature power reduction on |

**APC verify cycle** (Slice δ closed-loop):
1. Operator sends command 3 (Change power-reduction target) → inverter sets bit 1 of reg 30117 → 1 within ~1-2 s and returns the Q15 value at 41006.
2. Verifier ([server/apcVerify.js](../server/apcVerify.js)) schedules a delayed read; if `observed_q15` matches `requested_q15` within ±5 % AND bit 1 is set within 10 s → audit row `apc_write_verified` with `result = "ok"`. Otherwise `mismatch` / `no_response` / `timeout`.
3. UI verify chip on the %P Setpoint pane updates from the `apc_verify_log` table or via the live `apc.setpoint.state` WS broadcast.

---

## 5. Alarm bit reference (PDF §2.2 pg 13)

Locked by [server/tests/alarmReferenceShape.test.js](../server/tests/alarmReferenceShape.test.js).

| Bit (hex) | Symbol | Meaning |
|---|---|---|
| 0x0001 | `ALARMA_FRED` | Grid frequency outside limits (49-51 Hz European; site uses NGCP 60 Hz envelope) |
| 0x0002 | `ALARMA_VRED` | Grid voltage outside limits (195-253 V) |
| 0x0004 | `ALARMA_PI_ANA` | Current PI saturation |
| 0x0008 | `ALARMA_RESET_WD` | Inverter reset by watchdog |
| 0x0010 | `ALARMA_IRED_EFICAZ` | Excessive RMS grid current |
| 0x0020 | `ALARMA_TEMPERATURA` | Power electronics > 80 °C |
| 0x0040 | `ALARMA_LEC_ADC` | A/D converter read error |
| 0x0080 | `ALARMA_IRED_INSTA` | Instantaneous AC overcurrent |
| 0x0100 | `ALARMA_PROT_AC` | AC protections |
| 0x0200 | `ALARMA_PROT_DC` | DC protections |
| 0x0400 | `ALARMA_PARO_AISL_DC` | DC isolation failure |
| 0x0800 | `ALARMA_FRAMA` | Power electronics branch failure |
| 0x1000 | `ALARMA_PARO_MANUAL` | Manual stop |
| 0x2000 | `ALARMA_CONFIG` | Configuration change |
| 0x4000 | `ALARMA_VIN` | Excessive input voltage |
| 0x8000 | `ALARMA_VPV_MED_MIN` | Minimum input voltage |

All three latched/instantaneous/maintained alarm registers (30007-30008, 30065-30066, 30067-30068) share this bit layout.

---

## 6. Command codes (PDF §3 pg 15-17)

| Code | Action | Data parameter | Limits | Response | Notes |
|---|---|---|---|---|---|
| 0 | No-op | – | – | – | – |
| 1 | Change phi tangent target | Int16 phi × 32767 | ±15870 (±0.48) | Current phi target | NGCP PGC GCR 4.4.4.1 PF 0.95 lag/lead → tan(φ) = ±0.329 → raw ±10780 (Slice ζ + θ Test T3) |
| 2 | Read phi tangent target | – | – | Current phi target | – |
| **3** | **Change power-reduction target** | UInt16 Q15 | 0 (0 %) … 32767 (100 %) | Current Q15 | **Implemented (v2.10.x APC)**. Slice δ adds verify; Slice θ wraps in Test T5 sweep. |
| **4** | **Read power-reduction target** | – | – | Current Q15 (min 1638 = 5 %) | Slice δ verify uses this OR direct read of holding 41006 |
| **5** | **Stop inverter** | UInt16 sender node | 1 … 254 | 1 = stopped, 2 = started | **Implemented** as 1-reg form (PDF spec is multi-master RTU; our TCP transport doesn't need it). |
| **6** | **Start inverter** | UInt16 sender node | 1 … 254 | 1 = stopped, 2 = started | Same |
| 7-8 | No-op | – | – | – | – |
| 9 | Change reactive power ref | Int16 KVAr / 10 | ± nominal ÷ 10 | KVAr / 10 | Slice ζ + Slice θ (Test T3 Q-V capability) |
| 10 | No-op | – | – | – | – |
| 11 | Disable reactive ref | – | – | – | Slice ζ — restore default after Q-V test |
| 12 | Enable restrictive freq limits | UInt16 0/1 | 0 / 1 | – | **DO NOT ISSUE.** PDF semantics are European 50 Hz; site is firmware-baked NGCP Country Code 42. We READ holding 41010 for visibility, never WRITE cmd 12. |
| 13 | Inject reactive without DC | Int16 KVAr / 10 | ± nominal ÷ 10 | KVAr / 10 | Slice ζ — night-time PF correction (rarely useful — deferred) |
| 14 | Stop reactive injection w/o DC | – | – | – | Slice ζ paired with cmd 13 |

**Response semantics:** "If the INGECON SUN receives a command it resends the frame to the sender" (PDF pg 17). After writing 41001 + 41002, the value at those registers is the inverter's **response** — not a copy of what we wrote. STOP/START in particular replies with `1` (currently stopped) or `2` (currently started), which is **different from the command code 5/6**.

---

## 7. Wire-format example (PDF pg 10-12)

47-register read starting at address 0:

```
Request:  [slave][0x04][0x00 0x00][0x00 0x2F][CRC]
Response: [slave][0x04][0x5E][94 data bytes][CRC]
```

Data ordering: high byte first, big-endian per register. UInt32 fields (`Etotal`, `Hours`, `Conex`, `Alarmas`) are hi-lo register order, big-endian within each register.

---

## 8. Implementation status snapshot (2026-05-11)

| Slice | Status | Detail |
|---|---|---|
| α — decode-correctness | ✅ Done | Int16 sign casts on `idc` + `pac`; alarm bits locked |
| β — slow-poll + diagnostic capture | ✅ Done | 30-second slow-poll runs in [services/inverter_engine.py:1511](../services/inverter_engine.py#L1511); columns added to `inverter_5min_param`; Parameters page "Show advanced columns" toggle wired |
| γ — authoritative inverter state | ✅ Done | Decoder always-on in Parameters page; setting reserved for Inverter Card chip swap |
| δ — APC closed-loop verification | ✅ Done | Verifier + `apc_verify_log` + UI chip + WS broadcast |
| ε — standard-Modbus stop-reason cross-check | ✅ Done | Endpoint + table + side-by-side render in Stop Reasons admin |
| ζ — reactive + grid-code read-back | ❌ Not started | Hardware-risky; gates θ.4 (Test T3 Q-V) |
| η — this reference card | ✅ Done | This file |
| θ — Grid Test harness | 🟡 Partial | T2 + T5 done; T3 stubbed (waits on ζ); T1 deferred (waits on weather station) |

Live audit: [audits/2026-05-11/modbus-revamp-implementation-status.md](../audits/2026-05-11/modbus-revamp-implementation-status.md).

---

## Appendix — PDF page index

| PDF page | Content |
|---|---|
| 1 | Title — AAS1000ICB08 |
| 2 | TOC |
| 3 | Introduction |
| 4-6 | Input register map 30001-30058 (lifetime, live, suntracker, analog) |
| 6-7 | Resettable counters + alarm windows 30059-30068 |
| 7 | Diagnostic + state 30069-30077 |
| 7-8 | Stop-reason history 30078-30108 + 30 motive-code definitions |
| 8 | Connection countdown + MS mirrors 30109-30115 |
| 9 | 1000 V kit + power-reduction status 30116-30117 |
| 10-12 | FC 0x04 wire-format example (47-reg read, 94 data bytes) |
| 13-14 | Alarm bit reference + suntracker / MS bits |
| 15 | Holding registers 41001-41012 |
| 16-17 | Command code table (0-14) + response semantics |
