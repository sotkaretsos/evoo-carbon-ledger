# Requirement sources and policy parameters

The requirements R1–R9 (Section 2.5 and Table 6 of the article) were derived from the following sources:

- ISO 14067:2018, *Greenhouse gases — Carbon footprint of products — Requirements and guidelines for quantification*.
- GH11: WRI/WBCSD, *Product Life Cycle Accounting and Reporting Standard* (2011), https://ghgprotocol.org/sites/default/files/standards/Product-Life-Cycle-Accounting-Reporting-Standard_041613.pdf
- GS22: GS1, *EPCIS Standard* 2.0 (June 2022), https://ref.gs1.org/standards/epcis/2.0.0/
- NI18: Yaga et al., *Blockchain Technology Overview*, NISTIR 8202 (2018), https://doi.org/10.6028/NIST.IR.8202
- PR13: Moreau, L.; Missier, P., eds. *PROV-DM: The PROV Data Model*. W3C Recommendation, 30 April 2013, https://www.w3.org/TR/prov-dm/

| Requirement | Source location | Failure addressed | Control in the prototype |
|---|---|---|---|
| R1: attribution to a source class and an actor | GH11 §8.3.1, §8.3.4–8.3.8; PR13 §5.3.2 (Attribution) | An estimate or secondary value is presented as a measurement; responsibility cannot be traced | Actor, role, source class and document identifier stored with each event |
| R2: device identity and calibration | GS22 §7.3.7.1.1 (SensorMetadata), §7.3.7.1.2 (SensorReport); NI18 §7.3 | A device is faulty, impersonated or used beyond its calibration interval | Registered device keys, calibration records, signatures bound to scope and envelope |
| R3: units and plausible ranges | GH11 Appendix C, Table C.2; GS22 §7.3.3 (What dimension), §7.3.7.1.5 (UOM) | Units or reference bases are mixed; implausible values are accepted | Governed unit, phase and range per variable; oil-yield check |
| R4: lot custody and transformation | GS22 §7.4.5 (TransformationEvent), §7.3.6.4; GH11 Appendix C, Table C.2 | Quantities or burdens are duplicated or omitted when lots are transferred, merged or processed | Dual-signature custody transfer; mixing rule; mass balance |
| R5: factor-set and method versions | GH11 §11.2; Appendix C, Table C.1 | Results use different factors, GWP bases or calculation versions without trace | Versioned factor sets with content hash, second approval and retirement |
| R6: functional unit, boundary and allocation | GH11 Chapter 6 (§6.2), Chapter 7 (§7.2), Chapter 9 (§9.2), Chapter 13 (§13.2) | Results with different reference flows, boundaries or co-product treatment are compared | Mandatory method fields; functional unit consistent with the recorded output |
| R7: correction with history | GS22 §7.4.1.2 (ErrorDeclaration); PR13 §5.2.2 (Revision); NI18 §7.1 | A correction leaves an approved result apparently current or removes the audit trail | Authorized replacement; revision and snapshot checks; outdated certificates |
| R8: confidentiality and integrity | GS22 §8.2.2 (Authorisation and redaction); NI18 §3.1, §3.3, §7.5–7.7 | Sensitive records are exposed; unauthorized actors submit or change data | Role checks; raw evidence off-chain with hash verification |
| R9: retention of off-chain evidence | GH11 Appendix C, Tables C.1 and C.2 | A hash remains while its evidence is deleted, corrupted or withheld | Retention period, replicas and retrieval checks |

## Policy parameters

The numerical policies are consortium parameters set at deployment:

1. **Mass tolerance of 1%** between the sender's declaration and the mill's weighbridge reading. In operation, it is set from the scale calibration and resolution; it applies to custody transfers, not to the olive-to-oil conversion.
2. **Oil yield of 5–35 L per 100 kg of olives** as plausibility range at batch closure and after corrections of the oil output (case: 19.8 L per 100 kg).
3. **Evidence retention of at least five years.**
4. **At least two evidence replicas**, held in separate storage domains.
