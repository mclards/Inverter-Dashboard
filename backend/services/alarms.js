"use strict";
/**
 * alarms.js — Ingeteam INGECON SUN PowerMax 920TL DCAC Outdoor
 * Alarm register: 16-bit bitfield (AAV2015IQE01_B §19.2–19.4)
 * Audit log: every control action (start/stop node/all) is persisted
 */

const { db, stmts, getSetting, queryAuditRangeArchiveAware } = require("./db");
const { broadcastUpdate } = require("./ws");
const { classifyAlarmTransition } = require("./alarmEpisodeCore");

// ─── 16-bit alarm bitfield ───────────────────────────────────────────────────
// Bit labels: fleet-canonical per AAV2015IQE01_B §19.2-19.4 (920TL variant).
// Metadata fields (altLabel/level1Ref/level2Ref/trinPM/schematicPage/
// physicalDevices) sourced from the Ingeteam service-reference PDFs in docs/:
//   Inverter-Incident-Workflow.pdf       (AAV2011IMC01_, Level 1, 06/2014)
//   Inverter-Incident-Workflow-Level2.pdf (AAV2011IFA01_, Level 2, 06/2014)
//   Inverter-Schematic-Diagram.pdf        (AQM0027, 22pp wiring)
const ALARM_BITS = [
  {
    bit: 0,
    hex: "0001",
    label: "Frequency Alarm",
    severity: "warning",
    description: "Grid frequency out of range — inverter disconnects until the grid stabilizes.",
    action: "Wait for the grid to stabilize. Inverter auto-reconnects when frequency returns within FREC setpoints — only intervene if it persists on a verified-stable grid.",
    safetyPrep: [
      "Press the emergency push-button OR display STOP first — the 0x1000 (Manual shutdown) alarm should appear, confirming the inverter is offline (per L1 p.6).",
      "AC bus and Q4 breaker remain energized FROM THE GRID even with the inverter stopped. Treat them as live until proven otherwise with a meter.",
      "Wear arc-rated PPE for the AC bus voltage class (Cat 2 minimum on a 400 Vac system).",
      "Have a calibrated multimeter and the commissioning record (FREC high/low setpoints) in hand before you start.",
    ],
    actionSteps: [
      "⚠ Press emergency stop or display STOP first. Confirm 0x1000 appears. AC bus is still grid-energized.",
      "On the inverter display, read Vac1, Vac2, Vac3 and the frequency for every node. Note the values.",
      "Vac reads 0 V on any phase: the Q4 thermal magnetic breaker (or an upstream breaker in the shelter) has tripped — find why before you reset it (L1 p.6 NOTE).",
      "Open the AC compartment and measure phase-to-phase Vac at the AC output terminal bars with a multimeter. Compare against the display.",
      "Display matches multimeter: the CT/VT path is healthy. Check the measured frequency is within ±0.5 Hz of nominal.",
      "Frequency stabilizing within range: the grid is fine — inverter will auto-reconnect. No further action.",
      "Frequency out of range: this is a GRID issue, not the inverter. Notify the utility / plant operator. Inspect transformer, switchgear and other plant components for distress (L1 p.6).",
      "Grid verified stable but alarm persists: open SUN Manager → SCOPE tool (TrinPM18). Plot Vac1, Vac2, Vac3 — look for distorted waveform, missing phase, or DC offset (L2 p.6).",
      "Display reading differs from external multimeter by > ±2%: calibration drift — recalibrate per TrinPM20.",
      "Waveform abnormal: capture the SCOPE plot and contact INGETEAM Technical Support with the capture attached.",
      "RVAC AC surge arrester pilot flag visible (red): replace per TrinPM10 BEFORE re-energizing. A tripped arrester can re-trigger 0001 on reconnect.",
    ],
    expectedReadings: [
      "Vac1, Vac2, Vac3 (line-to-line): within ±10% of nameplate (e.g. 360–440 Vac on a 400 Vac nominal system).",
      "Frequency: within ±0.5 Hz of nominal — 49.5–50.5 Hz on a 50 Hz grid, 59.5–60.5 Hz on a 60 Hz grid.",
      "Q4 thermal breaker poles: all UP (closed); no tripped indicator visible.",
      "RVAC pilot flags: GREEN. Any RED flag means the arrester has triggered and must be replaced.",
    ],
    altLabel: "Grid frequency out of range (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=6",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=6",
    trinPM: ["TrinPM12", "TrinPM16", "TrinPM18", "TrinPM20", "TrinPM10"],
    schematicPage: 6,
    schematicNote: "Schematic p.6 — AC supply (acometida): the Q4 thermomagnetic breaker, AC surge arresters (RVAC), per-module FAC1/FAC2/FAC3 phase fuses, neutral connection (XN), and the optional external contact at XAUX.5 for remote QAC opening. Use it to trace the AC measurement path back to the terminal bars.",
    physicalDevices: [
      "AC output terminal bars — inside the AC compartment, top of rear cabinet, behind the AC compartment door.",
      "Q4 thermal magnetic breaker — front panel of the AC compartment, one per electronic block.",
      "AC varistors — inside the electronic block, mounted near the AC bus connection.",
      "RVAC AC surge arresters — top of the AC compartment, accessible from the front; check pilot-flag indicator.",
    ],
    escalateWhen: [
      "Grid frequency / voltage verified within range, setpoints match the commissioning record, calibration verified — alarm still appears.",
      "SCOPE waveform shows distortion, missing phase or DC offset that does not correlate with any visible grid event.",
      "Alarm repeats more than 3 times in 1 hour after every check above passes — likely a measurement-board fault.",
    ],
    note: "If the alarm fires only at sunrise / sunset (Vac slow swing), check for utility-side voltage regulation issues — not an inverter fault.",
  },
  {
    bit: 1,
    hex: "0002",
    label: "Voltage Alarm",
    severity: "warning",
    description: "Grid voltage out of range (over/under) — inverter disconnects until the grid stabilizes.",
    action: "Wait for the grid to stabilize. Inverter auto-reconnects when Vac returns within VAC setpoints — only intervene if it persists on a verified-stable grid.",
    safetyPrep: [
      "Press the emergency push-button OR display STOP first — confirm 0x1000 appears, confirming the inverter is offline (per L1 p.6).",
      "AC bus and Q4 breaker stay live FROM THE GRID even with the inverter stopped. Treat as live until proven otherwise.",
      "Wear arc-rated PPE for the AC bus voltage class.",
      "Have a calibrated multimeter and the commissioning record (VAC min/max setpoints) ready before you start.",
    ],
    actionSteps: [
      "⚠ Press emergency stop or display STOP first. Confirm 0x1000 appears. AC bus is still grid-energized.",
      "On the display, read Vac1, Vac2, Vac3 per node and note the values.",
      "Vac reads 0 V on any phase: Q4 (or an upstream breaker) has tripped — find why before resetting (L1 p.6 NOTE).",
      "Open the AC compartment and measure phase-to-phase Vac at the AC output terminal bars. Compare against the display.",
      "Display matches multimeter: CT/VT path is healthy.",
      "Compare measured Vac against the inverter's configured VAC min/max setpoints (commissioning record / SUN Manager → grid code).",
      "Within range: grid is fine — inverter will auto-reconnect. No further action.",
      "Out of range: notify the utility / plant operator. Inspect transformer tap, switchgear and other plant components.",
      "Grid stable but alarm persists: open SUN Manager → SCOPE (TrinPM18). Plot Vac1, Vac2, Vac3 — look for swell, sag, distortion, or DC offset.",
      "Display reading differs from multimeter by > ±2%: recalibrate per TrinPM20.",
      "RVAC pilot flag visible (red): replace per TrinPM10 before re-energizing.",
      "0x0102 = bit 1 (this) + bit 8 (AC Protection) co-occurs at reconnect: this is the AC-protection follow-on — work the bit 8 (0x0100) flow first; it's the upstream cause.",
    ],
    expectedReadings: [
      "Vac1, Vac2, Vac3: within VAC min/max setpoints (typically ±10% of nominal).",
      "Q4 thermal breaker: closed, no tripped indicator.",
      "RVAC pilot flags: GREEN.",
    ],
    altLabel: "Grid voltage out of range (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=6",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=6",
    trinPM: ["TrinPM12", "TrinPM16", "TrinPM18", "TrinPM20", "TrinPM10"],
    schematicPage: 6,
    schematicNote: "Schematic p.6 — AC supply (acometida): Q4 thermomagnetic breaker, AC surge arresters (RVAC), per-module FAC1/FAC2/FAC3 phase fuses, neutral (XN), and the optional XAUX.5 external contact for remote QAC opening.",
    physicalDevices: [
      "AC output terminal bars — inside the AC compartment, top of rear cabinet behind the door.",
      "Q4 thermal magnetic breaker — front panel of AC compartment, one per electronic block.",
      "AC varistors — inside the electronic block, near the AC bus.",
      "RVAC AC surge arresters — top of AC compartment, accessible from the front.",
    ],
    escalateWhen: [
      "Grid Vac verified within VAC setpoints, setpoints match commissioning record, calibration verified — alarm still appears.",
      "SCOPE waveform shows distortion that does not correlate with any visible grid event.",
      "Alarm repeats more than 3 times in 1 hour after every check passes.",
    ],
  },
  {
    bit: 2,
    hex: "0004",
    label: "Current Control Fault",
    severity: "fault",
    description: "Internal current control loop saturated — the inverter could not hold its AC current reference.",
    action: "Try one remote restart. If it returns, capture DebugDesc via SCOPE and follow the matching sub-code branch; escalate if it repeats within 1 hour.",
    safetyPrep: [
      "If you can remote-restart from the dashboard / SUN Manager without opening the cabinet, do that first — many 0004s self-clear.",
      "Before opening the cabinet: press emergency stop or display STOP, then wait at least 5 minutes for bus capacitors to discharge.",
      "Both AC and DC sides may remain energized (grid + PV) — wear arc-rated PPE for both classes.",
      "Have INGECON SUN Manager open with the SCOPE tool (TrinPM18). DebugDesc is what tells you which branch to follow.",
    ],
    actionSteps: [
      "Try ONE remote restart from the dashboard or SUN Manager. Clean reconnect → monitor for repeats and log it.",
      "Alarm returns within 1 hour: open SUN Manager → SCOPE (TrinPM18) and capture the DebugDesc value BEFORE doing anything physical (L2 p.7).",
      "DebugDesc 40: open the cabinet (TrinPM02). Reseat the J4, J5, and J21 connectors on the measuring board. Verify each one seats fully and the locking tab clicks.",
      "DebugDesc 92: a reactive-power calibration is required. Run TrinPM20. If alarm persists after calibration → replace the electronic block (TrinPM03 hardware + TrinPM04 software).",
      "DebugDesc 107, 108 or 109: this is actually a Vdc problem masquerading as 0004 — switch over to the 0x8000 (DC Undervoltage) flow. Don't replace anything yet (L2 p.7).",
      "DebugDesc anything else: visually check the back inductors (rear panel access, or remove the side panels + holding plate). Burn marks, discoloration, or swollen housing → contact INGETEAM SAT (L1 p.7).",
      "Back inductors look OK: open Q2(n) and measure resistance: each AC output phase to Q2(n).1 / Q2(n).3 / Q2(n).5 respectively, AND Q2(n).1-Q2(n).3-Q2(n).5 to K1(n).1-K1(n).3-K1(n).5 respectively (L1 p.7).",
      "Any reading below 2 Ω: short to ground or shorted contactor — STOP. Contact INGETEAM SAT before re-energizing.",
      "All readings above 2 Ω AND back inductors OK AND J-connectors reseated: pull a SCOPE log of Iac1/Iac2/Iac3 and escalate to SAT with the capture.",
    ],
    expectedReadings: [
      "Resistance from each AC phase to Q2(n).1/.3/.5: > 2 Ω (any lower → short).",
      "Resistance from Q2(n).1/.3/.5 to K1(n).1/.3/.5: > 2 Ω.",
      "J4, J5, J21 connectors on the measuring board: fully seated, locking tab clicked, no bent pins.",
      "Back inductors: no burn marks, no discoloration, no swollen housing.",
    ],
    altLabel: "Control current saturation (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=7",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=7",
    trinPM: ["TrinPM18", "TrinPM20", "TrinPM03", "TrinPM04"],
    schematicPage: 5,
    schematicNote: "Schematic p.5 — harmonic filter and K1 AC contactor for one electronic block (the same circuit repeats per module). Terminals: QAC.2/.4/.6 and U.XAC.2/.3/.4. The back inductors are part of this stage. Use this page to trace the current-sensor wiring and the K1 contactor power path you'll be measuring.",
    physicalDevices: [
      "Back inductors — accessible from the rear panel of the cabinet (or by removing both the electronic block + holding plate and the lateral panels). Visual inspection only — do NOT handle while energized.",
      "Q2 (Q2(n)) AC disconnect — front of AC compartment, one per electronic block. Open BEFORE measuring resistance.",
      "K1 (K1(n)) AC contactor — inside the AC compartment near the harmonic filter (schematic p.5). Coil powered from the +15 Vdc auxiliary rail (p.12).",
      "J4 / J5 / J21 connectors — on the measuring board inside the electronic block. Reseat firmly; verify locking tab clicks.",
      "Current sensors — at the AC output bars from each electronic block.",
    ],
    escalateWhen: [
      "Any phase-to-Q2(n) resistance reads below 2 Ω.",
      "Back inductors show visible damage (burn marks, discoloration, swollen housing).",
      "DebugDesc value is not 40, 92 or 107-109, and the back inductors look OK.",
      "Alarm repeats within 1 hour after every check above passes — pull SCOPE log and escalate.",
    ],
    debugDesc: {
      "40": "Reseat J4 / J5 / J21 connectors on the measuring board (TrinPM03).",
      "92": "Reactive-power calibration drift — run TrinPM20. If it persists after calibration, replace the electronic block.",
      "107,108,109": "Vdc source is suspect — switch to the 0x8000 (DC Undervoltage) workflow.",
    },
  },
  {
    bit: 3,
    hex: "0008",
    label: "DSP Watchdog Reset",
    severity: "fault",
    description: "Inverter DSP watchdog fired — firmware or comms-induced reset.",
    action: "One-off resets self-recover. Only intervene if the reset loops: verify poll rate, then comms, then firmware.",
    safetyPrep: [
      "Single reset: don't open the cabinet. Just watch for repeats.",
      "Reset loop confirmed: stop the inverter from the display before opening the cabinet for CAN-bus inspection.",
      "Comms work involves only low-voltage signaling; standard PPE is sufficient. AC/DC compartments are NOT involved.",
    ],
    actionSteps: [
      "Single reset followed by clean reconnect: no action — log it and move on (L1 p.7).",
      "Reset loop: first check the SCADA / poller poll interval. The vendor explicitly requires ≥ 1 communication per second (L1 p.7) — faster polling forces repeat resets.",
      "Poll rate is OK: temporarily disconnect the external SCADA (or set the dashboard's poller to idle) and watch for 24 h. If the reset stops, the comms system is the cause — fix at the SCADA side.",
      "Loop persists with SCADA disconnected: open the cabinet (TrinPM02). Inspect the CAN-bus connectors and the fiber to the synchronism card. Reseat any loose connector.",
      "Loop still persists: upgrade the inverter firmware per TrinPM19 (L2 p.8 escalation path).",
      "Loop survives the firmware upgrade: replace the electronic block per TrinPM03 (hardware) + TrinPM04 (software). Escalate to Ingeteam SAT.",
    ],
    expectedReadings: [
      "SCADA / poller cycle time: ≥ 1 second per inverter (vendor-mandated minimum).",
      "After a reset, the inverter should reconnect to the grid within ~30 s and resume normal MPPT.",
      "CAN-bus indicator LEDs on the electronic block: all 4 LEDs glowing when auxiliaries are ON.",
    ],
    altLabel: "Reset (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=7",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=8",
    trinPM: ["TrinPM21", "TrinPM19"],
    schematicPage: 22,
    schematicNote: "Schematic p.22 — CAN inter-module communication: AAV0089 / AAV0291 cards, AQL0212/0213/0214 cable variants for 3/4/5-node configurations, display GND, and the wire color code (mesh / green / yellow / white / brown). Use this page to identify which CAN cable variant is installed and trace the bus end-to-end.",
    physicalDevices: [
      "CAN-bus cables and connectors — between modules and to the display board (schematic p.22). Reseat suspect connectors; verify locking tabs.",
      "SCADA / external comms link — from the dashboard's poller (or third-party SCADA) to the inverter. Check the poll rate FIRST.",
      "Synchronism card and its fiber-optic interconnects — verify red light visible at the fiber ends.",
    ],
    escalateWhen: [
      "Reset loop persists after both the poll-rate verification AND the firmware upgrade.",
      "Reset accompanied by CAN-bus LED outage on one or more electronic blocks.",
    ],
    note: "If SCADA / poller polls faster than 1/sec the inverter will repeatedly reset (vendor explicit limit, L1 p.7).",
  },
  {
    bit: 4,
    hex: "0010",
    label: "RMS Overcurrent",
    severity: "fault",
    description: "RMS AC output current exceeded the inverter's rated maximum.",
    action: "Do NOT reset first. Co-occurrence with 0090/0880/0890 → block replacement. Otherwise verify currents via SCOPE and calibration before re-energizing.",
    safetyPrep: [
      "⚠ Do NOT remote-reset before physical inspection — re-energizing into a real overcurrent condition can destroy the IGBT block.",
      "Press emergency stop or display STOP. Open Q2(n) AND Qac to isolate the AC output. Lockout / tag-out both.",
      "AC bus is still grid-energized upstream of Qac. Wait 5 minutes after stop for bus capacitor discharge before opening the electronic block.",
      "Wear arc-rated PPE rated for the AC bus voltage class.",
    ],
    actionSteps: [
      "⚠ Do not attempt a remote reset until the AC output is physically inspected.",
      "Read the alarm word for this unit. If 0x0090 / 0x0880 / 0x0890 co-occur on the SAME unit: replace the electronic block (TrinPM03 hardware + TrinPM04 software). The internal AC current sensor or its conditioning circuit has failed (L1 p.8).",
      "Co-occurrence absent: open Q2(n), inspect the AC output cabling for insulation damage, burn marks or water ingress.",
      "Inspect AC current sensors at the electronic-block AC output (schematic p.5). Reseat or clean any disturbed/contaminated connectors.",
      "Run TrinPM20 (Inverter Calibration) for the AC currents. If calibration finishes cleanly, close Q2(n) and remote-restart cautiously while watching SCOPE.",
      "Calibration fails OR alarm returns: open SUN Manager → SCOPE (TrinPM18). Plot Iac1, Iac2, Iac3. Look for waveform asymmetry, missing phase, or saturation (L2 p.9).",
      "SCOPE waveform abnormal: capture and contact Ingeteam SAT with the capture.",
      "SCOPE waveform OK but alarm persists: upgrade the inverter firmware per TrinPM19. If still alarming, replace the electronic block (TrinPM03/TrinPM04).",
    ],
    expectedReadings: [
      "Iac1, Iac2, Iac3 (in SCOPE): symmetric three-phase sinusoid, no DC offset, no clipping.",
      "AC current sensor connectors: fully seated, no corrosion, no displacement.",
      "AC output cabling: no burn marks, no compromised insulation, dry (no water ingress).",
      "After successful calibration: alarm should NOT return on the next reconnect.",
    ],
    altLabel: "Effective grid current (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=8",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=8",
    trinPM: ["TrinPM18", "TrinPM20", "TrinPM19", "TrinPM03", "TrinPM04"],
    schematicPage: 6,
    schematicNote: "Schematic p.6 — AC supply path. The AC current sensors that the L1 workflow references are at the AC output bars from each electronic block; for the contactor + harmonic-filter context those bars feed, see p.5.",
    physicalDevices: [
      "AC current sensors — at the AC output bars from each electronic block. Connectors clipped to the block side; reseat by hand.",
      "AC output cabling — between the electronic block and the AC terminal bars (top of rear cabinet). Inspect for visible damage.",
      "Q2(n) AC disconnect — front of AC compartment per block; open BEFORE inspection.",
      "Electronic block (TrinPM03/04) — replacement candidate when 0090/0880/0890 co-occur.",
    ],
    escalateWhen: [
      "0x0090 / 0x0880 / 0x0890 co-occur on the same unit (electronic-block replacement is the root-cause fix).",
      "SCOPE waveform shows asymmetric / clipped / missing-phase Iac after calibration and visible inspection both pass.",
      "Alarm returns immediately after a clean calibration — internal sensor failure suspected.",
    ],
    note: "If 0090/0880/0890 co-occur, replace the electronic block (TrinPM03/04) per L1 p.8 — that's the root-cause fix.",
  },
  {
    bit: 5,
    hex: "0020",
    label: "Overtemperature",
    severity: "fault",
    description: "Power-electronics temperature exceeded 80 °C — the inverter de-rates then stops to protect the IGBTs.",
    action: "Distinguish ambient/environment-driven (TempINT < 80 °C, TempCI < 78 °C) from sensor-driven (TempCI = -14 °C) and clean the cooling path before restart.",
    safetyPrep: [
      "If alarm fires mid-day with hot ambient: this is likely environmental — investigate from outside the cabinet first (ambient temperature, fan rotation, filter condition).",
      "Before opening the cabinet: press emergency stop or display STOP. Allow at least 5 minutes for capacitor discharge.",
      "Hot surfaces inside the cabinet — heat sinks may be > 70 °C even after stop. Use heat-resistant gloves if you must touch the heat sink.",
      "Wear standard PPE for both AC and DC compartments.",
    ],
    actionSteps: [
      "Read TempINT and TempCI on the display (L1 p.8). Note the values per electronic block.",
      "TempINT < 80 °C AND TempCI < 78 °C: it's not a real overtemp — go straight to the TempCI = -14 °C branch below (sensor failure).",
      "TempINT around 105 °C: real overtemp on this block. Check the ambient temperature inside the cabinet.",
      "Ambient > 45 °C: environmental — the room is too hot to cool the inverters. Improve site cooling (more air, shading, AC). Maintenance also: clean the air filters and the heat sink per the installation manual (L1 p.8).",
      "Ambient ≤ 45 °C: open the affected electronic block. Check NTC sensors and thermal switches per TrinPM14 (L1 p.8).",
      "NTC or thermal switch is damaged: replace the electronic block per TrinPM03 + TrinPM04.",
      "TempCI = -14 °C (impossible reading — sensor open): can you measure +15 Vdc between U(n)X3.8 and U(n)X3.10? (L2 p.9)",
      "+15 Vdc present at U(n)X3.8↔U(n)X3.10: sensor wiring fine — upgrade the inverter firmware per TrinPM19. If alarm persists, replace the electronic block.",
      "+15 Vdc NOT present: check the auxiliaries per TrinPM05. Then verify the 15 Vdc PSU: 220 Vac at the PSU input (from auxiliaries), 15 Vdc at the PSU output, and wiring continuity. Replace the PSU if damaged (L2 p.9).",
      "Allow cooldown below 70 °C before any restart attempt.",
    ],
    expectedReadings: [
      "TempINT (internal): well below 80 °C in normal operation; alarm threshold = 80 °C.",
      "TempCI (cooling): below 78 °C in normal operation; alarm threshold = 78 °C.",
      "TempCI = -14 °C: SENSOR FAULT (open NTC), not a real reading.",
      "+15 Vdc at U(n)X3.8 ↔ U(n)X3.10: present (auxiliary supply healthy).",
      "Cabinet ambient: ≤ 45 °C for spec'd operation.",
    ],
    altLabel: "Temperature (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=8",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=9",
    trinPM: ["TrinPM14", "TrinPM03", "TrinPM04", "TrinPM05"],
    schematicPage: 17,
    schematicNote: "Schematic p.17 — TVQDC and +15V routing for 2/3-block vs. 4-block units. The NTC sensors and thermal switches themselves live on the electronic block (no dedicated schematic sheet). Use p.17 to trace the +15 Vdc rail that powers the sensors back to the PSU when you're checking U(n)X3.8↔U(n)X3.10.",
    physicalDevices: [
      "NTC temperature sensors — on the heat sink inside each electronic block. Inspected per TrinPM14.",
      "Thermal switches — bonded to the heat sink inside the electronic block.",
      "15 Vdc PSU — feeds the auxiliary rail that powers the NTC measurement chain. 220 Vac in / 15 Vdc out.",
      "Cooling fans — top / side of cabinet. Verify rotation by ear and visual.",
      "Air filters — front intake of cabinet. Clean per installation manual when blocked.",
    ],
    escalateWhen: [
      "+15 Vdc auxiliary rail OK, NTCs/thermal switches verified, firmware upgraded, electronic block replaced — alarm still appears.",
      "TempINT trends upward steadily even with clean filters and good fan rotation in cool ambient — heat-sink fouling internal.",
    ],
    note: "If ambient > 45 °C, classify as weather-driven (per L1 p.8). Site cooling, not an inverter fault.",
  },
  {
    bit: 6,
    hex: "0040",
    label: "ADC / Sync Error",
    severity: "fault",
    description: "ADC reading error or loss of grid synchronism — the inverter cannot trust its measurement path.",
    action: "If LVRT kit installed and Vdc < 400 V, this is normal — wait. Otherwise check fiber-optic links, sync-card supply, and follow the DebugDesc sub-code.",
    safetyPrep: [
      "If the LVRT kit is installed AND Vdc < 400 V, this alarm is EXPECTED — wait for Vdc to climb. Don't open anything (L1 p.9).",
      "Before opening the cabinet: press emergency stop or display STOP. Confirm 0x1000 appears.",
      "Auxiliary 220 Vac is present at the synchronism card even with the inverter stopped — wear arc-rated PPE for that class.",
      "Have INGECON SUN Manager + SCOPE (TrinPM18) ready to read DebugDesc — it dictates which branch you take.",
    ],
    actionSteps: [
      "Confirm whether the unit has the LVRT kit installed. If yes AND Vdc < 400 V: this is expected — the alarm clears once Vdc rises. Do nothing (L1 p.9).",
      "No LVRT kit (or Vdc ≥ 400 V): access the inverter per TrinPM02. Extract the fiber-optic cables from the affected electronic block and reconnect the auxiliaries.",
      "Check the state of the fiber-optic cables and the synchronism card per TrinPM08. Look for dust, scratches or mis-alignment at the fiber tip.",
      "With auxiliaries ON, can you see the red light at the end of the fiber-optic cables? (L1 p.9)",
      "Red light visible: fiber path is OK. Check the wiring per TrinPM23. If wiring OK → INVERTER OK. If wiring NOT OK → review and contact INGETEAM Technical Support.",
      "Red light NOT visible: measure 220 Vac between J1.1 and J1.2 terminals on the synchronism card (L2 p.10).",
      "220 Vac present at J1.1↔J1.2: contact INGETEAM to get a replacement of the synchronism card or fiber-optic cables.",
      "220 Vac NOT present: check the wiring — confirm 220 Vac between X8.4 and X8.8, continuity X8.4 ↔ J1.1, continuity X8.8 ↔ J1.2 (L2 p.10).",
      "Wiring OK: open SUN Manager → SCOPE (TrinPM18) and capture the DebugDesc value.",
      "DebugDesc 55 or 56: master-slave stop cascade — when the master stops, all slaves also stop. Reconnect the master first; the slaves recover automatically (L2 p.10).",
      "DebugDesc 119: check the state of the DC contactor / DC switch AND the LVRT kit. Inspect both before any reset (L2 p.10).",
      "Suspected grid quality issue (harmonics / dips / flicker): escalate to the utility — this is sometimes a grid event, not an inverter fault.",
    ],
    expectedReadings: [
      "Red light visible at every fiber-optic cable end with auxiliaries ON.",
      "220 Vac measured between J1.1 and J1.2 on the synchronism card.",
      "Continuity X8.4 ↔ J1.1 connector, X8.8 ↔ J1.2 connector.",
      "220 Vac measured between X8.4 and X8.8.",
      "If LVRT kit installed: alarm clears automatically once Vdc rises above 400 V.",
    ],
    altLabel: "Hardware fault (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=9",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=10",
    trinPM: ["TrinPM23", "TrinPM08", "TrinPM18"],
    schematicPage: 21,
    schematicNote: "Schematic p.21 — RS-485 and synchronism comms: AAV0133 (sync / measurement card), the triangular-waveform sync between modules, RS-485 communication via XCOM, optional current-measurement boards (MM1/MM4 or MH1/MH4), and the AQL0181/0182/0184 cable variants. Use this page to identify which sync card variant is installed and to trace the J1.1/J1.2 supply.",
    physicalDevices: [
      "Synchronism card (AAV0133) — inside the inverter cabinet near the electronic blocks. J1.1 / J1.2 = 220 Vac auxiliary input.",
      "Fiber-optic cables — between each electronic block and the synchronism card. Red light visible at the ends when energized.",
      "X8.4 / X8.8 auxiliary wiring — terminal block that feeds the sync card; check 220 Vac and continuity to J1.1 / J1.2.",
      "LVRT kit (if installed) — optional hardware for grid-fault ride-through. Vdc < 400 V here is normal-and-expected.",
    ],
    escalateWhen: [
      "Red light NOT visible at fiber ends AND 220 Vac present at J1.1↔J1.2: card or fiber needs replacement — contact Ingeteam.",
      "DebugDesc value is not 55, 56 or 119 — and wiring/red-light/220 Vac all check out.",
      "Repeated 0x0040 in master-slave configurations after master reconnect — possible sync card drift.",
    ],
    debugDesc: {
      "55,56": "Master-slave stop cascade — when the master stops, all slaves stop. Reconnect the master first; slaves recover automatically.",
      "119": "DC contactor or LVRT kit state is abnormal — inspect both before any reset.",
    },
  },
  {
    bit: 7,
    hex: "0080",
    label: "Instantaneous Overcurrent",
    severity: "fault",
    description: "Instantaneous AC current exceeded the peak protection threshold — a hard AC fault is likely.",
    action: "De-energize before inspection. If 0090/0880/0890 co-occur → block replacement. Otherwise look for AC short, then sensor / IGBT damage.",
    safetyPrep: [
      "⚠ Open Q2(n) AND Qac BEFORE any physical inspection — the AC side stays live from the grid even with the inverter stopped.",
      "Wait at least 5 minutes after stopping for bus capacitors to discharge.",
      "Wear arc-rated PPE for the AC bus voltage class. Suspected short → consider Cat 3 PPE.",
      "Have INGECON SUN Manager open with the SCOPE tool (TrinPM18) to capture Iac waveforms before re-energizing.",
    ],
    actionSteps: [
      "⚠ Open Q2(n) AND Qac before any physical inspection. AC side may remain energized from the grid.",
      "Read the alarm word for this unit. If 0x0090 / 0x0880 / 0x0890 co-occur on the SAME unit: replace the electronic block per TrinPM03 + TrinPM04 (L1 p.9).",
      "Co-occurrence absent: visually inspect the AC cabling (between block and AC terminal bars) for insulation damage, burn marks, or water ingress.",
      "Check the current-sensor connectors on the electronic block (schematic p.5). Reseat any disturbed connector.",
      "No external fault found: open SUN Manager → SCOPE (TrinPM18). Plot Iac1, Iac2, Iac3 (L2 p.11).",
      "Iac waveform abnormal: capture the SCOPE plot and contact INGETEAM SAT with the capture.",
      "Iac waveform OK: upgrade the inverter firmware per TrinPM19.",
      "Alarm persists after firmware upgrade: replace the electronic block per TrinPM03 + TrinPM04 — internal sensor or IGBT gate driver damage.",
    ],
    expectedReadings: [
      "Iac1, Iac2, Iac3 (SCOPE): symmetric sinusoid, no DC offset, no clipping or saturation.",
      "Current sensor connectors: fully seated, no displacement.",
      "AC cabling: no visible damage, no burn marks, dry.",
      "AC bus across Q2(n) (with Q2(n) closed and inverter running): line-to-line within VAC range.",
    ],
    altLabel: "Instantaneous grid current (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=9",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=11",
    trinPM: ["TrinPM18", "TrinPM03", "TrinPM04"],
    schematicPage: 5,
    schematicNote: "Schematic p.5 — harmonic filter and K1 AC contactor for one electronic block (same circuit per module). The current sensors live on the AC output bus that this stage drives. Use this page to trace which sensor connector belongs to which phase.",
    physicalDevices: [
      "Current-sensor connectors — on the electronic block, at the AC output bus side. Reseat firmly by hand.",
      "AC cabling — between electronic block and AC terminal bars; visible from inside the AC compartment.",
      "Q2(n) AC disconnect — front of AC compartment per block; open BEFORE inspection.",
      "Qac main AC breaker — upstream of Q2(n); also open for full AC isolation.",
    ],
    escalateWhen: [
      "0x0090 / 0x0880 / 0x0890 co-occur on the same unit (electronic-block replacement is the root-cause fix per L1 p.9).",
      "SCOPE Iac waveform abnormal even after visual inspection passes.",
      "Alarm persists after both firmware upgrade AND electronic-block replacement — escalate to SAT for IGBT diagnosis.",
    ],
  },
  {
    bit: 8,
    hex: "0100",
    label: "AC Protection Fault",
    severity: "critical",
    description: "AC protection device tripped — surge arresters (RVAC), fuses (FAC), or breakers (Qac/Q2n/Qaux/Q4n).",
    action: "Lockout before inspection. If 0x0102 (with bit 1 Voltage), work the 0001/0002 flow first. Otherwise check every AC protection device end-to-end.",
    safetyPrep: [
      "⚠ Lockout / tag-out Q2(n) AND Qac — the AC side stays live from the grid even with the inverter stopped.",
      "Press emergency stop or display STOP first. Confirm 0x1000 appears.",
      "Wait at least 5 minutes after stopping for bus capacitors to discharge.",
      "Wear arc-rated PPE for the AC bus voltage class (Cat 2 minimum, Cat 3 if a short is suspected).",
      "Have a calibrated multimeter (continuity + Vac), spare AC fuses, and spare AC arresters on hand before opening anything.",
    ],
    actionSteps: [
      "⚠ Lockout / tag-out Q2(n) AND Qac before any physical inspection.",
      "Access the inverter per TrinPM02. Check internal magnetic breakers and the components they protect — turn each ON if needed (L1 p.10).",
      "Qac → inverter and electronic-block verifications.",
      "Qaux → 15 Vdc PSU, contactor, DC breaker, ventilation fans, synchronism card, night power supply.",
      "Q2(n) → AC filter capacity for that block.",
      "Q4(n) → varistor status for that block.",
      "Reconnect AC power and auxiliaries. Is the inverter now displaying the 0x0102 alarm? (= bit 8 + bit 1 Voltage).",
      "0x0102 present: this is a post-reconnect frequency / voltage follow-on — go to the 0001/0002/0003 (Frequency / Voltage) flow first; that's the upstream cause (L1 p.10).",
      "0x0102 absent: read Vac1/Vac2/Vac3 per node on the display. Are the measured AC voltages within the inverter's AC range?",
      "Vac out of range: go to the 0001/0002/0003 (Frequency / Voltage) flow.",
      "Vac in range: check the state of the AC surge arresters (RVAC). Replace any damaged arrester per TrinPM10.",
      "Arresters OK: check continuity per TrinPM25. If continuity OK → INVERTER OK on reconnect.",
      "Continuity NOT OK: reconnect auxiliaries, check +15 Vdc per TrinPM26 (L2 p.12).",
      "When the K2 relay is pressed, can you measure +15 Vdc between J19.3 and J19.10 connectors? (L2 p.12).",
      "Yes (+15 Vdc present): when you disconnect the AC side and press the K2 relay, does the AC contactor close simultaneously? If yes → INVERTER OK on reconnect. If no → check wiring (220 Vac X8.4↔X8.8; continuity X8.4↔K1(n).A1; continuity X8.8↔K1(n).A2). Replace the AC contactor when needed (L2 p.12).",
      "No (+15 Vdc absent): check and solve any incident with the wiring (L2 p.12). INVERTER OK once wiring restored.",
      "Wiring all OK but alarm persists: upgrade the inverter firmware per TrinPM19. If still persists, replace the electronic block per TrinPM03 + TrinPM04.",
    ],
    expectedReadings: [
      "Qac, Qaux, Q2(n), Q4(n) breakers: all in ON position, no tripped indicators.",
      "RVAC pilot flags: GREEN.",
      "K2 relay pressed → +15 Vdc between J19.3 and J19.10.",
      "K2 relay pressed (AC disconnected) → AC contactor (K1) closes simultaneously.",
      "220 Vac between X8.4 and X8.8 (auxiliary supply to contactor coil).",
      "Continuity X8.4 ↔ K1(n).A1 and X8.8 ↔ K1(n).A2.",
    ],
    altLabel: "AC protection (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=10",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=12",
    trinPM: ["TrinPM10", "TrinPM25", "TrinPM26", "TrinPM19"],
    schematicPage: 12,
    schematicNote: "Schematic p.12 — +15 Vdc auxiliary rail distribution to all four modules. These rails power the K1 contactor coil, breaker auxiliaries, NTC sensors and synchronism cards. The breakers / fuses / arresters themselves live on p.5 (K1 + harmonic filter) and p.6 (Q4, Qac, RVAC, FAC fuses). Open whichever device you're inspecting at the right page.",
    physicalDevices: [
      "Qac / Qaux / Q2(n) / Q4(n) magnetic breakers — front panel of AC compartment.",
      "K1 AC contactor — inside the AC compartment near the harmonic filter (schematic p.5). Coil energized from +15 Vdc rail.",
      "RVAC AC surge arresters — top of AC compartment; check pilot flag.",
      "FAC1/FAC2/FAC3 AC fuses — per electronic block (schematic p.6). Check continuity if any phase reads 0 V.",
      "K2 relay + J19.3 / J19.10 — auxiliary contactor-driver path (TrinPM26).",
      "X8.4 / X8.8 + K1(n).A1 / K1(n).A2 — contactor-coil supply wiring.",
    ],
    escalateWhen: [
      "Every AC protection device verified intact AND wiring continuity OK AND +15 Vdc rail healthy — alarm persists.",
      "K1 contactor doesn't close when K2 relay is pressed despite +15 Vdc and intact wiring (replace contactor first; if persists, escalate).",
      "Alarm returns after firmware upgrade AND electronic-block replacement.",
    ],
    note: "0x0102 co-occurrence (0x0100 | 0x0002) indicates a post-reconnect frequency / voltage follow-on — work the bit 1 (Voltage) flow FIRST.",
  },
  {
    bit: 9,
    hex: "0200",
    label: "DC Protection Fault",
    severity: "critical",
    description: "DC protection device tripped — fuses (XFDC), surge arresters (RVDC), or the grounding-kit breaker.",
    action: "Lockout QDC before inspection. PV strings still feed DC side even at night. Then check arresters → fuses → grounding kit → 15 Vdc PSU in order.",
    safetyPrep: [
      "⚠ Open QDC and lockout / tag-out (schematic p.4). DC side remains energized by the PV strings even with the inverter stopped.",
      "Disconnect PV strings at the combiner if string-level work is needed.",
      "DC bus capacitors take 5+ minutes to discharge after stop — do NOT open the electronic block immediately.",
      "Wear DC-rated arc PPE (DC clears differently than AC — use DC-rated insulating gloves and tools).",
      "Have a 1000 Vdc-rated multimeter, spare DC fuses (matching rating), and spare DC arresters on hand.",
    ],
    actionSteps: [
      "⚠ Open QDC and lockout. DC side remains energized by the PV strings.",
      "Access the inverter per TrinPM02. Measure impedance between IRVDC.n.11 ↔ Ground AND IRVDC.n.12 ↔ Ground. (L1 p.11)",
      "Both readings show large resistance (open circuit, no leakage): INVERTER OK or contact Ingeteam Technical Support.",
      "Either reading is low: check the state of the DC surge arresters. Replace any damaged DC arrester per TrinPM10.",
      "After arrester check, can continuity be measured between IRVDC.n.11 ↔ IRVDC.n.12 AND XMDC(n+2) ↔ U(n).J19.1? (L1 p.11)",
      "No continuity: review wiring at those points.",
      "Continuity OK: does the inverter have a 'blown fuse sensor at the DC input' kit? If yes → review and replace any damaged DC fuses (no continuity between XFDC.1 ↔ XFDC.2 = blown fuse, replace per TrinPM11).",
      "Fuses OK: does the inverter have a grounding kit? If yes → turn on (or replace) the thermal magnetic breaker included in the grounding kit if no continuity between XFDC.2 ↔ XFDC.3 (L1 p.11).",
      "All physical devices intact: reconnect auxiliaries and confirm 15 Vdc between these points (L2 p.13): XFDC.1 ↔ X7DC.4, XMDC.1 ↔ X7DC.4, XMON(n).n ↔ XDIS(n).0, U(n)X3.1 ↔ U(n)X3.10, U(n)J19.1 ↔ U(n)J19.10.",
      "Any of those is missing 15 Vdc: solve the wiring incident at that pair.",
      "All 15 Vdc points OK: upgrade the inverter firmware per TrinPM19.",
      "Alarm persists after firmware upgrade: verify the 15 Vdc PSU (220 Vac at PSU input from auxiliaries; 15 Vdc at PSU output; wiring). Replace PSU if damaged. If still persists, replace the electronic block per TrinPM03 + TrinPM04 (L2 p.13).",
      "Close QDC only after every protection device is confirmed intact.",
    ],
    expectedReadings: [
      "Impedance IRVDC.n.11 ↔ Ground: large (open).",
      "Impedance IRVDC.n.12 ↔ Ground: large (open).",
      "Continuity IRVDC.n.11 ↔ IRVDC.n.12.",
      "Continuity XFDC.1 ↔ XFDC.2 (= DC fuse healthy).",
      "Continuity XFDC.2 ↔ XFDC.3 (if grounding kit present).",
      "15 Vdc at: XFDC.1↔X7DC.4, XMDC.1↔X7DC.4, XMON(n).n↔XDIS(n).0, U(n)X3.1↔U(n)X3.10, U(n)J19.1↔U(n)J19.10.",
      "PSU: 220 Vac in, 15 Vdc out.",
    ],
    altLabel: "DC protection (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=11",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=13",
    trinPM: ["TrinPM10", "TrinPM03", "TrinPM04"],
    schematicPage: 14,
    schematicPageExtra: 16,
    schematicNote: "Schematic p.14 — module-level wiring continuation. The QDC motorized switch and DC arresters live on p.4; the QDC motorization control on p.11; and p.16 (the 'extra' link below) covers the +15 V auxiliary rail that powers the grounding-kit relay and the protection-monitoring chain. Open p.4/p.11 for the protection devices themselves and p.14/p.16 for the auxiliary supply.",
    physicalDevices: [
      "QDC motorized DC switch — schematic p.4 (the device) and p.11 (the motorization control). Open BEFORE inspection.",
      "RVDC DC surge arresters — DC input side, schematic p.4. Check pilot flag; replace per TrinPM10 if triggered.",
      "XFDC DC fuses — DC input fuse holders. Continuity XFDC.1↔XFDC.2 = healthy. Replace as a parallel-bank set if any is blown (TrinPM11).",
      "Grounding-kit thermal magnetic breaker (if installed) — protects XFDC.2↔XFDC.3 path.",
      "15 Vdc PSU — auxiliary supply for the protection-monitoring chain (schematic p.16). 220 Vac in / 15 Vdc out.",
      "IRVDC.n.11 / IRVDC.n.12 — DC arrester monitoring terminals. Impedance to ground = leakage indicator.",
    ],
    escalateWhen: [
      "Impedance IRVDC.n.11 / IRVDC.n.12 to ground reads large (open) AND alarm persists — internal monitor circuit may be faulty.",
      "Every wiring continuity check passes, all 15 Vdc points present, PSU healthy, firmware upgraded, electronic block replaced — alarm still appears.",
      "Pattern of repeated 0x0200 across multiple modules within the same inverter — common-mode failure suspected.",
    ],
  },
  {
    bit: 10,
    hex: "0400",
    label: "Insulation / Ground Fault",
    severity: "critical",
    description: "DC insulation resistance fell below the safe threshold — the PV array or wiring is leaking to ground.",
    action: "Lockout. Identify whether the fault is INTERNAL or in the PV array (TrinPM06), then isolate strings and find the faulty one.",
    safetyPrep: [
      "⚠ Open QDC and place the inverter in SAFE state before any string work. Lockout / tag-out.",
      "PV strings remain energized from the panels — DC side is live during the day. Work at dawn or after panel cover-up if possible.",
      "Use a 1000 Vdc-rated insulation tester (megger) and DC-rated insulating gloves.",
      "Have the IEC 62446 acceptance criteria handy: ≥ 1 MΩ per string typical threshold.",
      "Identify whether the fault is internal (inverter) or external (PV array) BEFORE opening anything per TrinPM06.",
    ],
    actionSteps: [
      "Identify the type of insulation fault per TrinPM06 (L1 p.12).",
      "Fault is NOT internal: the DC insulation fault is in the PV array. Find and solve the field incident (water ingress, damaged jacket, degraded MC4) — that's required before the inverter will run properly (L1 p.12).",
      "Fault IS internal: check the state of the DC surge arresters. Replace any damaged DC arrester per TrinPM10 (L1 p.12).",
      "Arresters OK or replaced: check the state of the DC contactor. Verify the contactor coil OR its commanding relay is working (L2 p.13).",
      "Contactor OK: check impedance per TrinPM27 (DC side). If the measured value is below 2 Ω → review and restore wiring.",
      "TrinPM27 OK: check impedance per TrinPM28 (auxiliaries). If < 2 Ω → review and restore wiring.",
      "TrinPM28 OK: check impedance per TrinPM29 (AC side). If < 2 Ω → review and restore wiring.",
      "Once internal path is clean: open QDC, disconnect all PV strings at the combiner, and measure insulation per string with a 1000 Vdc megger (PV+ vs. GND, PV- vs. GND).",
      "IEC 62446 acceptance: each string ≥ 1 MΩ. Reconnect strings one at a time to identify the faulty string.",
      "Inspect the faulty string for water ingress, damaged cable jackets, or degraded MC4 connectors.",
      "All strings pass but alarm persists: DC contactor or the internal insulation monitor may be faulty — escalate to Ingeteam SAT.",
    ],
    expectedReadings: [
      "Insulation resistance per string (PV+ vs. GND, PV- vs. GND): ≥ 1 MΩ at 1000 Vdc (IEC 62446).",
      "Impedance TrinPM27 (DC side) / TrinPM28 (auxiliaries) / TrinPM29 (AC side): all > 2 Ω.",
      "DC contactor coil: energizes when commanded; commanding relay clicks audibly.",
      "RVDC arrester pilot flags: GREEN.",
    ],
    altLabel: "DC insulation (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=12",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=13",
    trinPM: ["TrinPM06", "TrinPM10", "TrinPM27", "TrinPM28", "TrinPM29"],
    schematicPage: 4,
    schematicNote: "Schematic p.4 — DC input side per module: PV+ / PV- terminals, the AAS0190 common-mode filter, DC surge arresters (RVDC), the QDC motorized DC switch, and the bus capacitors (U.BUS+ / U.BUS-). Use this page to trace the DC path you'll be megger-testing.",
    physicalDevices: [
      "DC contactor — commanded by the +15 Vdc rail; verify coil energizes. Mechanical click should be audible on command.",
      "RVDC DC surge arresters — schematic p.4. Check pilot flag; replace per TrinPM10 if triggered.",
      "PV string insulation — measured at the combiner per string with a 1000 Vdc megger.",
      "Common-mode filter (AAS0190) — schematic p.4, between PV inputs and the rest of the DC path.",
      "MC4 connectors at string entries — common failure point: water ingress, UV degradation.",
    ],
    escalateWhen: [
      "All strings pass insulation test (≥ 1 MΩ each) but alarm persists — DC contactor or internal insulation monitor faulty.",
      "TrinPM27/28/29 impedance checks all > 2 Ω AND arresters intact AND contactor OK — alarm still appears.",
      "Insulation degradation appears progressively across multiple strings — site-wide environmental issue (flooding, panel breach).",
    ],
  },
  {
    bit: 11,
    hex: "0800",
    label: "Contactor Fault",
    severity: "fault",
    description: "AC contactor K1 state does not match the commanded state (fleet-specific — see variant warning).",
    action: "Use the fleet (920TL) K1 procedure. Do NOT follow the AAV2011 branch-fault flow — that does not apply to this fleet.",
    safetyPrep: [
      "⚠ Variant divergence — confirm you're working a 920TL (fleet) and not following the AAV2011 branch-fault flow.",
      "Press emergency stop or display STOP first. Confirm 0x1000 appears.",
      "Open Q2(n) AND Qac to isolate AC. Wait 5 minutes for capacitor discharge.",
      "K1 contactor coil is on the +15 Vdc rail — that side is low-voltage. The K1 power contacts are AC-bus level — wear AC arc-rated PPE.",
      "Have a multimeter (continuity + Vdc), the contactor's coil-resistance value (stamped on the body), and a spare K1 contactor on hand.",
    ],
    actionSteps: [
      "⚠ Follow the 920TL fleet procedure below. AAV2011 Level 1/Level 2 map this bit to a 'branch fault' that requires a 15-day SUN Manager export — that flow does NOT apply to the 920TL.",
      "Open Q2(n) to isolate the AC output. Lockout / tag-out.",
      "Inspect K1 AC contactor (schematic p.5) for welded contacts (won't open), burned auxiliaries, or open-circuit coil.",
      "Measure K1 coil resistance with a multimeter and compare against the value stamped on the contactor body. Out of tolerance → coil damaged.",
      "Verify the XK1 auxiliary feedback contact actually mirrors the main contact state. Mismatched feedback (main contact closed but feedback says open, or vice-versa) is the usual trigger for 0x0800.",
      "K1 mechanically OK and feedback wiring intact: command the contactor open/closed (via the +15 Vdc command path on the auxiliary board) and watch for response.",
      "K1 doesn't respond: replace the control board that drives K1.",
      "K1 responds correctly but alarm persists: replace the K1 contactor.",
      "Alarm persists after K1 replacement: escalate to Ingeteam SAT — auxiliary feedback chain or firmware bug.",
    ],
    expectedReadings: [
      "K1 coil resistance: matches the value stamped on the contactor body (typically ~50-200 Ω depending on coil voltage).",
      "K1 main contacts: open when de-energized; close audibly when coil energized.",
      "XK1 auxiliary feedback: mirrors main-contact state (closed when main is closed, open when main is open).",
      "K1 control voltage: ~+15 Vdc on the command path when commanded to close.",
    ],
    altLabel: "Branch fault (AAV2011 L1/L2 — variant may differ)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=12",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=14",
    trinPM: ["TrinPM18"],
    schematicPage: 12,
    schematicNote: "Schematic p.12 — +15 Vdc auxiliary rails that drive the K1 contactor coils and the breaker auxiliaries. The K1 contactor itself (the device you're inspecting) lives on p.5 with the harmonic filter; the AC supply / fuses / arresters are on p.6. Open p.5 for K1 mechanical inspection and use p.12 only to trace the coil supply.",
    physicalDevices: [
      "K1 AC contactor (per fleet doc) — inside the AC compartment near the harmonic filter (schematic p.5). Coil powered from +15 Vdc rail (p.12).",
      "XK1 auxiliary contact — on K1 itself; mirrors main-contact state. Wired to the auxiliary feedback chain.",
      "K1 control board — the auxiliary board that drives the K1 coil command signal.",
      "Branches 1-3 (per 2011 docs, variant-only) — NOT physically present on the 920TL fleet; ignore in this variant.",
    ],
    escalateWhen: [
      "K1 replaced AND control board replaced AND wiring verified — alarm still appears.",
      "Fleet documentation in doubt — never use the AAV2011 branch-fault flow on a 920TL.",
    ],
    variantWarning: "Bit 11 diverges between fleet and 2011 docs. Fleet (920TL, AAV2015IQE01_B) = contactor fault → inspect K1. AAV2011 Level 1/2 map 0x0800 to branch fault → download 15-day history via SUN Manager, escalate to SAT. Verify fleet doc FIRST; the L2 branch-fault flow does NOT apply to the 920TL.",
  },
  {
    bit: 12,
    hex: "1000",
    label: "Manual Shutdown",
    severity: "info",
    description: "Inverter was stopped by emergency stop, door sensor, display STOP, or a remote command.",
    action: "Identify the shutdown source BEFORE restart. Check sub-codes (1320 / 1360 / 1363) for the auxiliaries-fault branch.",
    safetyPrep: [
      "Do NOT blind-restart — find what stopped the inverter first. Restarting into an unsafe condition is the #1 cause of secondary incidents.",
      "If restarting after door / limit-switch trip: confirm all doors and panels are physically secured before re-energizing.",
      "If restarting after emergency-button trip: confirm the personnel who pressed it have left the area and the original hazard is gone.",
      "Wear PPE appropriate for whichever compartment you'll be inspecting.",
    ],
    actionSteps: [
      "Is 0x1000 displayed in combination with other alarm codes? If yes → access the inverter per TrinPM02 and reconnect auxiliaries. Then review the OTHER alarms individually — they're the real cause (L1 p.13).",
      "0x1000 alone: have you checked these three points?",
      "  1) Emergency button is RELEASED (rotate to release if pressed in).",
      "  2) Inverter is NOT stopped from the display (check display state).",
      "  3) Every inverter door is properly closed (door limit switches engaged).",
      "All three OK: access the inverter per TrinPM02. Get continuity between XMON(n).7 ↔ U(n)X3.6 AND U(n)X3.6 ↔ U(n)J19.8. Both should show continuity.",
      "Continuity NOT OK: review wiring at the failing pair.",
      "Continuity OK: reconnect auxiliaries. Do you get +15 Vdc between U(n)J19.8 ↔ U(n)J19.10? (L2 p.15)",
      "+15 Vdc present: was the inverter stopped by communications (SCADA / dashboard remote stop)? If yes → the comms system sent the stop. Contact the SCADA programmer to clear the source. If no → contact INGETEAM SAT.",
      "+15 Vdc NOT present: manually disable every limit switch and release the emergency push-button. Check continuity through that chain. (For symmetric inverters, contact INGETEAM SAT to get the right sequence — L2 p.15.)",
      "Stop-reason sub-code 1320: the +15 Vdc PSU LED is OFF. Confirm the PSU LED is ON. Replace the PSU if damaged (L2 p.15).",
      "Stop-reason sub-code 1360 or 1363: auxiliaries fault — check auxiliary services per TrinPM05. Verify +15 Vdc at U(n)J19.8 ↔ U(n)J19.10.",
      "All physical checks pass but 0x1000 persists: upgrade the inverter firmware per TrinPM19. If still persists, replace the electronic block per TrinPM03 + TrinPM04.",
      "Once safe AND the source is cleared: remote-restart from the dashboard.",
    ],
    expectedReadings: [
      "Emergency button SW2: released (out, not pressed in).",
      "All door limit switches: engaged (doors closed and latched).",
      "Continuity XMON(n).7 ↔ U(n)X3.6.",
      "Continuity U(n)X3.6 ↔ U(n)J19.8.",
      "+15 Vdc between U(n)J19.8 ↔ U(n)J19.10.",
      "+15 Vdc PSU LED: ON.",
    ],
    altLabel: "Manual shutdown (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=13",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=15",
    trinPM: ["TrinPM05", "TrinPM19", "TrinPM03", "TrinPM04"],
    schematicPage: 15,
    schematicNote: "Schematic p.15 — door limit-switch wiring: LS for doors 1-2, doors 3-4, and the supply door, all summed onto the +15 Vdc / GND safety chain that drives the 0x1000 manual-shutdown logic. Use this page to trace the door / limit-switch / XMON(n).7 path you're checking continuity on.",
    physicalDevices: [
      "Emergency stop button SW2 — front of cabinet (schematic p.15). Twist to release.",
      "Door limit switches — one per door (doors 1-2, doors 3-4, supply door). Engaged when door fully closed.",
      "XMON(n).7 — the safety-chain return point on the monitoring board.",
      "U(n)X3.6 / U(n)J19.8 / U(n)J19.10 — continuity / +15 Vdc check points on the electronic block.",
      "+15 Vdc PSU — the LED on this PSU should be ON; sub-code 1320 fires when this LED is OFF.",
    ],
    escalateWhen: [
      "Continuity intact, +15 Vdc present, no other alarms, sub-code is not 1320/1360/1363 — and 0x1000 persists.",
      "0x1000 returns immediately after every restart attempt despite emergency button released and doors confirmed closed — physical safety chain may have an intermittent open.",
    ],
    stopReasonSubcodes: ["1320", "1360", "1363"],
  },
  {
    bit: 13,
    hex: "2000",
    label: "Configuration Change",
    severity: "info",
    description: "Firmware update or parameter change was logged — informational, not a fault.",
    action: "Verify the changed parameters match the commissioning record. If they don't, revert from backup. No physical inspection needed.",
    safetyPrep: [
      "Informational only — no physical inspection or PPE required.",
      "Have the commissioning record / parameter backup file accessible (SUN Manager configuration snapshot).",
      "Do NOT restart the inverter for service until you've confirmed the parameters are correct — wrong grid-code or curtailment values can cause secondary alarms or even hardware damage.",
    ],
    actionSteps: [
      "Open SUN Manager and review the changed parameters: grid code, FREC / VAC setpoints, curtailment / Q-V curves, MPPT settings.",
      "Compare each parameter against the commissioning record / approved configuration backup.",
      "Values match: acknowledge this alarm — no further action.",
      "Values drifted or unexpected: revert from the commissioning backup BEFORE the inverter runs unattended. Wrong grid-code values can cause repeated 0x0001 / 0x0002 alarms or an undetected protection mismatch.",
      "Parameters loaded but alarm persists: upgrade the inverter firmware per TrinPM19 (L2 p.16). Configuration alarm sometimes clears only with a firmware refresh.",
      "Alarm persists after firmware upgrade: contact INGETEAM Technical Support — possible firmware corruption.",
    ],
    expectedReadings: [
      "Grid code: matches commissioning record exactly (e.g. PH-Energy-2024 / IEEE-1547 / etc.).",
      "FREC high/low setpoints: match the utility's current grid-code requirement.",
      "VAC min/max setpoints: match nameplate / utility requirement.",
      "Curtailment curves (if used): match the latest grid-services agreement.",
    ],
    altLabel: "Configuration / Firmware (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=14",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=16",
    trinPM: ["TrinPM19"],
    schematicPage: null,
    schematicNote: "No schematic page — this alarm is firmware/configuration only, no physical device involvement.",
    physicalDevices: ["Firmware configuration (no physical device — work is entirely in SUN Manager)."],
    escalateWhen: [
      "Firmware upgraded AND parameters reverted to commissioning values — alarm still appears.",
      "Suspected unauthorized parameter change (no operator log of recent SUN Manager session) — security event, escalate.",
    ],
  },
  {
    bit: 14,
    hex: "4000",
    label: "DC Overvoltage",
    severity: "critical",
    description: "DC input voltage exceeded 1000 Vdc — above the IGBT block rating; continued exposure damages hardware.",
    action: "IMMEDIATE: open QDC. If Vdc actually > 1000 V → PV array sizing fault (designer issue). If display reads > 1000 V but multimeter doesn't → calibration drift.",
    safetyPrep: [
      "⚠ IMMEDIATE: open QDC. Vdc > 1000 V exceeds the IGBT rating; every additional minute risks cascading hardware damage.",
      "Disconnect PV strings at the combiner if Vdc remains high after QDC open.",
      "PV strings remain energized — DC side is live during the day. Cover panels (or work at dawn) for any string-level work.",
      "Use a 1000 Vdc-rated multimeter (NOT a 600 V meter — that will be over-range and unreliable).",
      "Wear DC-rated arc PPE.",
    ],
    actionSteps: [
      "⚠ IMMEDIATE: press emergency push-button to stop the inverter. Open QDC.",
      "Read Vdc on the display per node.",
      "Display Vdc > 1000 V: confirm with a 1000 Vdc-rated multimeter at the DC input. If multimeter agrees → the PV array has been sized incorrectly (Voc cold-morning clamp exceeded). Per AAV2011 L1 p.14: this voids the inverter guarantee. Contact the PV plant designing team. Do NOT re-close QDC until the array is resized (L1 p.14).",
      "Display Vdc > 1000 V but multimeter shows a normal reading: this is a CALIBRATION drift, not a real overvoltage. Check the deviation between display and multimeter (L2 p.16).",
      "Large deviation: calibrate the inverter per TrinPM20.",
      "After calibration, alarm persists: upgrade the inverter firmware per TrinPM19. If still persists, replace the electronic block per TrinPM03 + TrinPM04.",
      "Inspect RVDC surge arresters (schematic p.4) for trigger flag — replace per TrinPM10 if any flag is shown (a tripped arrester near the limit can trigger the alarm).",
      "Do NOT re-close QDC until the root cause is resolved.",
    ],
    expectedReadings: [
      "Display Vdc: matches multimeter reading within ±2%.",
      "Vdc operating range: well below 1000 V (real PV array Voc at site Tmin should never exceed inverter spec).",
      "RVDC arrester pilot flags: GREEN.",
      "After calibration: display Vdc agrees with multimeter and alarm clears on next sunrise.",
    ],
    altLabel: "High input voltage (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=14",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=16",
    trinPM: ["TrinPM20", "TrinPM19"],
    schematicPage: 4,
    schematicNote: "Schematic p.4 — DC input side per module: PV+ / PV- terminals, the AAS0190 common-mode filter, DC surge arresters (RVDC), the QDC motorized DC switch, and the bus capacitors (U.BUS+ / U.BUS-). Use this page to locate the DC measurement point you'll verify with the multimeter.",
    physicalDevices: [
      "PV array (oversized — contact plant designer) — the actual root cause when display and multimeter agree above 1000 V.",
      "QDC motorized DC switch — schematic p.4. Open immediately.",
      "RVDC DC surge arresters — schematic p.4. Check pilot flag.",
      "DC input terminals — for multimeter verification of display reading.",
    ],
    escalateWhen: [
      "Display Vdc > 1000 V AND multimeter agrees AND alarm repeats at every cold morning — array is fundamentally oversized; engineering escalation, not service.",
      "Calibration done AND firmware upgraded AND electronic block replaced — alarm still appears.",
    ],
    note: "AAV2011 L1 p.14: 'inverter status is fine but PV array has been sized incorrectly — inverter guarantee lost'.",
  },
  {
    bit: 15,
    hex: "8000",
    label: "DC Undervoltage / Low Power",
    severity: "warning",
    description: "Vdc is below the MPPT operating range — usually irradiance-driven, not a fault.",
    action: "Expected at dawn / dusk / heavy overcast. Only investigate if alarming 09:00–15:00 on a clear day. Then check display vs multimeter, calibrate if drift.",
    safetyPrep: [
      "If alarm fires at dawn / dusk / under heavy overcast: this is normal — wait for irradiance. No action needed.",
      "If investigating a clear-day case: open QDC and lockout if you'll be measuring at the DC input. PV strings remain energized.",
      "Use a 1000 Vdc-rated multimeter for any DC voltage verification.",
      "Wear DC-rated PPE if opening the cabinet.",
    ],
    actionSteps: [
      "Alarming at dawn, dusk, or under heavy overcast: expected — no action.",
      "Alarming 09:00–15:00 on a clear day: investigate.",
      "Stop the inverter via the emergency push-button. Read Vdc on the display.",
      "Display Vdc clearly out of range (compare against nameplate / installation manual): the PV array has been sized incorrectly. Contact the plant designing team (L1 p.14).",
      "Display Vdc looks normal but alarm persists: check Vdc with a multimeter at the DC input. Compare against the displayed reading (L2 p.17).",
      "Large deviation between display and multimeter: calibrate the inverter per TrinPM20.",
      "No deviation: upgrade the inverter firmware per TrinPM19. If alarm persists, replace the electronic block per TrinPM03 + TrinPM04.",
      "Read per-string voltages at the combiner (megger or DC voltmeter). Any string clearly below its peers indicates a string-level fault — shading, soiling, disconnected MC4 connector.",
      "Verify QDC is fully closed and seated.",
    ],
    expectedReadings: [
      "Display Vdc: within MPPT operating range during daylight on a clear day.",
      "Display Vdc agrees with multimeter at DC input within ±2%.",
      "Per-string voltages at combiner: roughly equal across strings (within ±5% of each other).",
      "QDC: fully closed and seated.",
      "At sunrise / sunset: Vdc gradually crosses the MPPT lower bound — the alarm cycle is normal.",
    ],
    altLabel: "Panel voltage / Low input voltage (AAV2011 L1/L2)",
    level1Ref: "Inverter-Incident-Workflow.pdf#page=14",
    level2Ref: "Inverter-Incident-Workflow-Level2.pdf#page=17",
    trinPM: ["TrinPM20", "TrinPM19"],
    schematicPage: 4,
    schematicNote: "Schematic p.4 — DC input side per module: PV+ / PV- terminals, the AAS0190 common-mode filter, DC surge arresters (RVDC), the QDC motorized DC switch, and the bus capacitors (U.BUS+ / U.BUS-). Use this page to locate the DC measurement point for the multimeter check.",
    physicalDevices: [
      "PV array — verify per-string voltage at the combiner. Mismatched string = string-level fault (shading, soiling, MC4).",
      "QDC motorized DC switch — schematic p.4. Verify fully closed.",
      "DC input terminals — for multimeter vs display comparison.",
      "Combiner box — at the field (off-cabinet); per-string disconnect for diagnostic.",
    ],
    escalateWhen: [
      "Display Vdc agrees with multimeter, all strings healthy, calibration done, firmware upgraded, electronic block replaced — alarm still appears.",
      "Pattern of repeated 0x8000 in mid-day on clear days across multiple inverters — site-wide soiling or shading issue, not an inverter fault.",
    ],
    note: "Alarming at dawn / dusk / overcast is normal — typical at nightfall per L1 p.14. No action.",
  },
];

// Fatal-error state (all lower 15 bits set). Per AAV2011 L1 p.14:
//   "When a FATAL ERROR occurs, the inverter is unblocked by entering a code
//    through the display." — cannot be auto-reset remotely.
const FATAL_ALARM_VALUE = 0x7fff;

// Stop-reason sub-codes surfaced under 0x1000 (Manual shutdown) per L2 p.15.
// Read from the inverter display / stop-reason register (not in the 16-bit
// alarm word). Included here for UI drilldown reference.
const STOP_REASON_SUBCODES = {
  "1320": "15 Vdc power supply LED off — replace PSU if damaged",
  "1360": "Auxiliaries state fault — check auxiliary services (TrinPM05)",
  "1363": "Auxiliaries state fault — check +15Vdc at U(n)J19.8↔U(n)J19.10",
};

// Service reference documents, resolved relative to the app's /docs folder
// served by Express static. GitHub raw URLs provide the canonical copy so the
// renderer can offer a cross-origin auto-download that survives installer
// boundaries.
const SERVICE_DOCS = {
  schematic:    "Inverter-Schematic-Diagram.pdf",
  level1:       "Inverter-Incident-Workflow.pdf",
  level2:       "Inverter-Incident-Workflow-Level2.pdf",
  sunManager:   "INGECON-SUN-Manager-User-Manual.pdf",
};
const SERVICE_DOCS_GITHUB_BASE =
  "https://raw.githubusercontent.com/mclards/Inverter-Dashboard/main/docs";

const STOP_REASONS = {
  FREC: "Grid Frequency Out of Range",
  VAC: "Grid Voltage Out of Range",
  TEMPERATURE: "Overtemperature",
  "INS.FAILURE": "Insulation / Ground Fault",
  "FATAL ERROR": "Fatal Firmware Error — Contact Service",
  "LOW POWER": "Insufficient PV Power (Low Irradiance)",
  "REMOTE STOP": "Remote Stop Command Received",
  "EMERG STOP": "Emergency Stop Activated",
  OVERCURRENT: "AC Overcurrent Protection Triggered",
};

const SEV_ORDER = { critical: 4, fault: 3, warning: 2, info: 1 };

function decodeAlarm(val) {
  // The alarm bitfield is the full 32-bit regs 6-7 value (v2.9.0+). Coerce to
  // an unsigned 32-bit integer so high-word bits (16-31) decode correctly —
  // a bare `1 << 31` is negative in JS, so test via unsigned shift on `val`.
  const u = (Number(val) || 0) >>> 0;
  if (u === 0) return [];
  return ALARM_BITS.filter((b) => ((u >>> b.bit) & 1) === 1).map((b) => ({
    ...b,
    active: true,
  }));
}

function getTopSeverity(val) {
  const bits = decodeAlarm(val);
  if (!bits.length) return null;
  return bits.reduce(
    (best, b) => (SEV_ORDER[b.severity] > SEV_ORDER[best.severity] ? b : best),
    bits[0],
  ).severity;
}

function formatAlarmHex(val) {
  if (!val) return "0000H";
  return val.toString(16).toUpperCase().padStart(4, "0") + "H";
}

// ─── Active alarm state tracker ───────────────────────────────────────────────
const activeAlarmState = {}; // key: `${inv}_${unit}` → last alarm_value logged
const CONFIG_CACHE_MS = 5000;
let configuredNodeCache = { ts: 0, set: null };

// Module-level prepared statement — avoids re-preparing on every logControlAction call.
const stmtInsertAudit = db.prepare(`
  INSERT INTO audit_log (ts, operator, inverter, node, action, scope, result, ip, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function hydrateActiveAlarmStateFromDb() {
  try {
    // Reset to DB truth at process start so persistent active alarms
    // are not re-recorded/re-broadcast as new events after restart.
    for (const key of Object.keys(activeAlarmState)) {
      delete activeAlarmState[key];
    }
    // getActiveAlarms returns rows ORDER BY ts DESC — keep first seen per
    // (inv,unit) so legacy duplicate open rows don't leave us tracking an
    // older alarm_value, which would then mis-classify the next batch as
    // update_active and cascade updates across stale rows.
    const rows = stmts.getActiveAlarms.all();
    for (const r of rows || []) {
      const inv = Number(r?.inverter || 0);
      const unit = Number(r?.unit || 0);
      const alarmVal = Number(r?.alarm_value || 0);
      if (!inv || !unit || !alarmVal) continue;
      if (!isConfiguredNode(inv, unit)) continue;
      const key = `${inv}_${unit}`;
      if (activeAlarmState[key] !== undefined) continue;
      activeAlarmState[key] = alarmVal;
    }
  } catch (err) {
    // Best effort only; polling path will recover naturally.
    console.warn("[alarms] hydrateActiveAlarmStateFromDb failed:", err.message);
  }
}

function getConfiguredNodeSet() {
  const now = Date.now();
  if (configuredNodeCache.set && now - configuredNodeCache.ts < CONFIG_CACHE_MS) {
    return configuredNodeCache.set;
  }

  const invMax = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const nodeMax = Math.max(1, Number(getSetting("nodeCount", 4)) || 4);
  const defaultUnits = Array.from({ length: nodeMax }, (_, i) => i + 1);

  const set = new Set();
  try {
    const row = stmts.getSetting.get("ipConfigJson");
    const raw = row && row.value ? JSON.parse(row.value) : {};
    const unitsMap = raw && typeof raw === "object" ? raw.units || {} : {};
    for (let inv = 1; inv <= invMax; inv++) {
      const unitsRaw = unitsMap[inv] ?? unitsMap[String(inv)] ?? defaultUnits;
      const units = Array.isArray(unitsRaw)
        ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= nodeMax)
        : defaultUnits;
      for (const unit of [...new Set(units)]) {
        set.add(`${inv}_${unit}`);
      }
    }
  } catch (err) {
    // Fail-open fallback: keep all possible nodes if config is temporarily unreadable.
    console.warn("[alarms] getConfiguredNodeSet failed, using all nodes as fallback:", err.message);
    for (let inv = 1; inv <= invMax; inv++) {
      for (let unit = 1; unit <= nodeMax; unit++) {
        set.add(`${inv}_${unit}`);
      }
    }
  }

  configuredNodeCache = { ts: now, set };
  return set;
}

function isConfiguredNode(inverter, unit) {
  return getConfiguredNodeSet().has(`${Number(inverter) || 0}_${Number(unit) || 0}`);
}

function getActiveAlarms() {
  const rows = stmts
    .getActiveAlarms
    .all()
    .filter((r) => isConfiguredNode(r.inverter, r.unit));

  // Harden: if legacy duplicate active rows exist for one node,
  // keep only the latest row so UI tracker + table stay consistent.
  const latestByNode = new Map();
  for (const r of rows) {
    if (r.inverter == null || r.unit == null) continue;
    const key = `${Number(r.inverter || 0)}_${Number(r.unit || 0)}`;
    if (!key || key === "0_0") continue;
    if (!latestByNode.has(key)) {
      latestByNode.set(key, r);
      continue;
    }
    const prev = latestByNode.get(key);
    const curTs = Number(r?.ts || 0);
    const prevTs = Number(prev?.ts || 0);
    const curId = Number(r?.id || 0);
    const prevId = Number(prev?.id || 0);
    if (curTs > prevTs || (curTs === prevTs && curId > prevId)) {
      latestByNode.set(key, r);
    }
  }
  return Array.from(latestByNode.values()).sort(
    (a, b) =>
      Number(b?.ts || 0) - Number(a?.ts || 0) ||
      Number(b?.id || 0) - Number(a?.id || 0),
  );
}

// v2.10.0 Slice F — pluggable auto-capture hook. Wired up by index.js at
// startup so this module stays free of fetch/http/python dependencies.
// Signature: ({ alarmId, inverter, unit, alarmValue, eventAtMs }) => void
let _stopReasonAutoCapture = null;
function setStopReasonAutoCapture(fn) {
  _stopReasonAutoCapture = typeof fn === "function" ? fn : null;
}

function raiseActiveAlarm(row, cur, now, newAlarms) {
  const severity = getTopSeverity(cur) || "fault";
  const info = stmts.insertAlarm.run({
    ts: now,
    inverter: row.inverter,
    unit: row.unit,
    alarm_code: formatAlarmHex(cur),
    alarm_value: cur,
    severity,
    updated_ts: now,
  });
  const alarmId = Number(info?.lastInsertRowid || 0);
  newAlarms.push({
    id: alarmId,
    inverter: row.inverter,
    unit: row.unit,
    alarm_value: cur,
    severity,
    decoded: decodeAlarm(cur),
    ts: now,
  });

  // Slice F: fire-and-forget StopReason auto-capture stamped with the
  // poller-detected millisecond timestamp + alarm row id. Wrapped so any
  // hook failure cannot break the poller batch.
  if (alarmId && _stopReasonAutoCapture) {
    try {
      _stopReasonAutoCapture({
        alarmId,
        inverter: row.inverter,
        unit: row.unit,
        alarmValue: cur,
        eventAtMs: now,
      });
    } catch (err) {
      // Swallow — caller's hook should be defensive, but defend anyway.
    }
  }
}

// v2.11.0-beta.10 — close-and-reopen semantics on bit-composition change.
//
// Background (2026-05-22): The original implementation
// `UPDATE alarms SET alarm_value=? ...` clobbered the prior bitmask on
// every poll-cycle composition change. An alarm that briefly fired
// bits 4 + 9 (`0x0210`) and then settled back to bits 6 + 9 (`0x0240`)
// before clearing left ONLY `0x0240` in the DB — the bit-4 event the
// operator saw on the inverter card vanished from the log.
//
// An earlier in-session fix OR-accumulated (`alarm_value |= cur`) but the
// operator correctly pushed back: "very awkward and not right" — that
// approach manufactures fictional values like 0x0250 that NEVER appeared
// on the wire (bit 4 fired at time T1, bits 6+9 fired at time T2 — they
// were never all set together).
//
// Correct fix: every composition change CLOSES the active row (sets
// cleared_ts to the transition timestamp) and INSERTs a NEW row whose
// alarm_value is exactly what the inverter emitted at that moment.
// Each alarms row is now a faithful snapshot — no merging, no
// supersets, no overwrites. The operator's timeline for an episode
// becomes a sequence of consecutive rows whose cleared_ts of row N
// equals ts of row N+1.
//
// CRITICAL_PATTERNS auto-block is unaffected: it uses supermask
// semantics + the 60-min minSpacingMs gate, so rapid in-episode
// composition flaps are still counted as one fault.
//
// Broadcast suppressed for the close/reopen pair: the operator's toast
// already fired on the original raise; in-episode changes show up via
// the next /api/alarms/active refresh of the notification panel. This
// preserves the prior no-spam UX while now also preserving the data.
// Atomic close-and-reopen wrapped in a single SQLite transaction so any
// concurrent /api/alarms/active query cannot observe the brief gap
// between the old row's `cleared_ts` write and the new row's INSERT.
// Without this wrapper, a polling query that lands in the (microsecond-
// short) window would briefly report the unit as "no active alarm",
// causing transient false-clears in the notification panel and any
// auto-reset / critical-pattern logic that consumes getActiveAlarms.
const _closeAndReopenAlarmTx = db.transaction((row, newCur, evTsNum) => {
  stmts.clearAlarm.run(evTsNum, row.inverter, row.unit);
  if (newCur === 0) return;
  // Use a sink array so raiseActiveAlarm's INSERT still runs (and the
  // stop-reason auto-capture hook fires on the new alarm id), but the
  // operator doesn't get re-toasted for an in-episode change.
  const silentSink = [];
  raiseActiveAlarm(row, newCur, evTsNum, silentSink);
});

function updateActiveAlarmValue(row, cur, evTs) {
  const evTsNum = Number(evTs) > 0 ? Number(evTs) : Date.now();
  const newCur = (Number(cur) || 0) >>> 0;
  _closeAndReopenAlarmTx(row, newCur, evTsNum);
}

function checkAlarms(batch) {
  const newAlarms = [];
  const now = Date.now();
  const configured = getConfiguredNodeSet();

  // Remove in-memory alarm states for nodes no longer configured.
  for (const key of Object.keys(activeAlarmState)) {
    if (!configured.has(key)) delete activeAlarmState[key];
  }

  for (const row of batch) {
    try {
    if (!isConfiguredNode(row.inverter, row.unit)) continue;
    const key = `${row.inverter}_${row.unit}`;
    const prev = activeAlarmState[key];
    // Full 32-bit alarm bitfield (regs 6-7, v2.9.0+). `row.alarm` is the
    // DEPRECATED 16-bit low word (reg 7 only) — using it dropped every
    // high-word bit from episodes/DB/export/critical-pattern detection.
    // Fall back to it only for pre-v2.9 Python payloads without alarm_32.
    const cur = (Number(row.alarm_32) || 0) > 0
      ? Number(row.alarm_32)
      : Number(row.alarm) || 0;
    // Stamp each episode with the frame's own capture time (preserved by the
    // poller as row.ts) rather than one batch-wide Date.now() — a batch can
    // mix frames from different inverters/poll cycles (2.1 consistency).
    const evTs = Number(row.ts) > 0 ? Number(row.ts) : now;

    if (prev === undefined) {
      // T2.5 fix (Phase 5, 2026-04-14): hydrate from any existing
      // not-yet-cleared DB row before deciding whether to INSERT a new
      // active alarm.  Without this, every server restart that finds a
      // unit still alarming would insert a SECOND active row, inflating
      // counts and breaking episode grouping.
      const existing = stmts.getActiveAlarmForUnit
        ? stmts.getActiveAlarmForUnit.get(row.inverter, row.unit)
        : null;
      if (existing && cur !== 0) {
        // Re-attach to existing episode. Patch in place on drift; do NOT
        // re-broadcast — the operator has already seen this toast.
        if (Number(existing.alarm_value) !== cur) {
          updateActiveAlarmValue(row, cur, evTs);
        }
        activeAlarmState[key] = cur;
        continue;
      }
      if (existing && cur === 0) {
        // We're down, the unit cleared; close the existing row.
        stmts.clearAlarm.run(evTs, row.inverter, row.unit);
        activeAlarmState[key] = 0;
        continue;
      }
      activeAlarmState[key] = cur;
      if (cur !== 0) {
        raiseActiveAlarm(row, cur, evTs, newAlarms);
      }
      continue;
    }

    const transition = classifyAlarmTransition(prev, cur);
    if (transition === "noop") continue;

    if (transition === "clear") {
      stmts.clearAlarm.run(evTs, row.inverter, row.unit);
      activeAlarmState[key] = 0;
      continue;
    }

    if (transition === "update_active") {
      updateActiveAlarmValue(row, cur, evTs);
      activeAlarmState[key] = cur;
      continue;
    }

    if (transition === "raise") {
      raiseActiveAlarm(row, cur, evTs, newAlarms);
      activeAlarmState[key] = cur;
    }
    } catch (err) {
      // Per-row error isolation: a malformed frame or one transient DB
      // error MUST NOT abort the whole batch — every other inverter's
      // alarm transitions still need to be recorded. Log so the failure
      // is visible in operator logs, then continue.
      console.error(
        `[alarms] checkAlarms row inverter=${row?.inverter} unit=${row?.unit} failed: ${err?.message || err}`,
      );
    }
  }

  if (newAlarms.length) {
    broadcastUpdate({ type: "alarm", alarms: newAlarms });
  }
}

// ─── Audit Log ────────────────────────────────────────────────────────────────
function logControlAction({
  operator = "OPERATOR",
  inverter,
  node,
  action,
  scope,
  result,
  ip,
  reason,
}) {
  const inv = Number(inverter || 0);
  const nd  = Number(node || 0);
  const invMax = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
  const nodeMax = Math.max(1, Number(getSetting("nodeCount", 4)) || 4);

  if (!Number.isFinite(inv) || inv < 1 || inv > invMax) {
    console.warn("[alarms] logControlAction: invalid inverter value:", inverter);
    return;
  }
  // node 0 = ALL nodes; 1..nodeMax are individual nodes.
  if (!Number.isFinite(nd) || nd < 0 || nd > nodeMax) {
    console.warn("[alarms] logControlAction: invalid node value:", node);
    return;
  }

  const ts = Date.now();
  stmtInsertAudit.run(
    ts,
    operator || "OPERATOR",
    inv,
    nd,
    action,
    scope || "single",
    result || "ok",
    ip || "",
    reason || "",
  );
}

// Seed active in-memory alarm state from persisted active alarms.
hydrateActiveAlarmStateFromDb();

function getInverterIpMap() {
  try {
    const row = stmts.getSetting.get("ipConfigJson");
    const raw = row && row.value ? JSON.parse(row.value) : {};
    const src = raw && typeof raw === "object" ? raw.inverters || {} : {};
    const invCount = Math.max(1, Number(getSetting("inverterCount", 27)) || 27);
    const map = {};
    for (let inv = 1; inv <= invCount; inv++) {
      const v = String(src[inv] ?? src[String(inv)] ?? "").trim();
      if (v) map[inv] = v;
    }
    for (const [k, vRaw] of Object.entries(src || {})) {
      const inv = Math.trunc(Number(k));
      if (!Number.isFinite(inv) || inv < 1 || map[inv]) continue;
      const v = String(vRaw ?? "").trim();
      if (v) map[inv] = v;
    }
    return map;
  } catch (err) {
    console.warn("[alarms] getInverterIpMap failed:", err.message);
    return {};
  }
}

function isLoopbackIp(v) {
  const ip = String(v || "").trim().toLowerCase();
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip === "localhost" ||
    ip === "::ffff:127.0.0.1"
  );
}

function withAuditIpFallback(rows) {
  const ipMap = getInverterIpMap();
  return (rows || []).map((r) => {
    const cur = String(r?.ip || "").trim();
    if (cur && !isLoopbackIp(cur)) return r;
    const inv = Number(r?.inverter || 0);
    const fallbackIp = String(ipMap[inv] || "").trim();
    if (!fallbackIp) return r;
    return { ...r, ip: fallbackIp };
  });
}

function getAuditLog({ start, end, inverter, limit = 500 } = {}) {
  const s = start || 0;
  const e = end || Date.now();
  const safeLimit = Math.min(20000, Math.max(1, Math.trunc(Number(limit) || 5000)));
  const invNum = Math.trunc(Number(inverter || 0));
  // v2.11.1 — archive-aware so past-date /api/audit queries surface rows
  // migrated out of hot by retention pruning. Same contract as
  // queryAlarmsRangeArchiveAware: hot first, archive months merged in, sort
  // ts DESC, cap applied AFTER the merge.
  const rows = queryAuditRangeArchiveAware(s, e, {
    inverter: Number.isFinite(invNum) && invNum > 0 ? invNum : null,
    limit: safeLimit,
  });
  return withAuditIpFallback(rows);
}

module.exports = {
  decodeAlarm,
  getTopSeverity,
  formatAlarmHex,
  checkAlarms,
  getActiveAlarms,
  logControlAction,
  getAuditLog,
  ALARM_BITS,
  STOP_REASONS,
  STOP_REASON_SUBCODES,
  SERVICE_DOCS,
  SERVICE_DOCS_GITHUB_BASE,
  FATAL_ALARM_VALUE,
  classifyAlarmTransition,
  setStopReasonAutoCapture,
};

