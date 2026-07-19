use serde::{
    de::{Error as _, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fmt;

pub const COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.compute_expected_output_semantics.v1";
pub const COMPUTE_EXPECTED_OUTPUT_DERIVATION_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.compute_expected_output_derivation.v1";
pub const COMPUTE_EXPECTED_OUTPUT_CONTRACT_V2_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.compute_expected_output_contract.v2";

const SEMANTICS_HASH_DOMAIN: &str = "synthi.gpu_hmr.compute_expected_output_semantics_hash.v1";
const EXPECTED_VALUES_HASH_DOMAIN: &str = "synthi.gpu_hmr.compute_expected_output_values_hash.v1";
const CONTRACT_V2_HASH_DOMAIN: &str = "synthi.gpu_hmr.compute_expected_output_contract_hash.v2";
const COMPILE_TRANSPORT_NONCE_PREFIX: &str = "gpu-proof-transport-request:";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_DECIMAL_CHARS: usize = 128;
const MAX_OUTPUT_TARGET_CHARS: usize = 512;
const MAX_SHAPE_RANK: usize = 32;
const MAX_EXPECTED_VALUES: usize = 16_384;

const SEMANTICS_FIELDS: &[&str] = &[
    "schemaVersion",
    "comparisonMode",
    "outputTargetId",
    "byteOffset",
    "byteLength",
    "dtype",
    "shape",
    "elementCount",
    "byteOrder",
    "toleranceDecimal",
    "expectedValuesDecimal",
    "expectedValuesHash",
    "expectedRawHash",
    "semanticsHash",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeExpectedOutputSemantics {
    schema_version: String,
    comparison_mode: String,
    output_target_id: String,
    byte_offset: u64,
    byte_length: u64,
    dtype: String,
    shape: Vec<u64>,
    element_count: u64,
    byte_order: String,
    tolerance_decimal: String,
    expected_values_decimal: Option<Vec<String>>,
    expected_values_hash: Option<String>,
    expected_raw_hash: Option<String>,
    semantics_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputeExpectedOutputContractBindingV2 {
    pub project_id: String,
    pub edit_id: String,
    pub artifact_after_hash: String,
    pub output_target_id: String,
    pub oracle_code_hash: String,
    pub compile_transport_nonce: String,
    pub runtime_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeExpectedOutputContractV2 {
    schema_version: String,
    derivation_schema_version: String,
    semantics: ComputeExpectedOutputSemantics,
    binding: ComputeExpectedOutputContractBindingV2,
    contract_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawComputeExpectedOutputContractV2 {
    schema_version: String,
    derivation_schema_version: String,
    semantics: ComputeExpectedOutputSemantics,
    binding: ComputeExpectedOutputContractBindingV2,
    contract_hash: String,
}

impl ComputeExpectedOutputContractBindingV2 {
    fn validate(&self) -> Result<(), String> {
        for (label, value) in [
            ("projectId", self.project_id.as_str()),
            ("editId", self.edit_id.as_str()),
            ("outputTargetId", self.output_target_id.as_str()),
            ("runtimeSessionId", self.runtime_session_id.as_str()),
        ] {
            if !canonical_contract_token(value) {
                return Err(format!("derived contract binding field {label} is invalid"));
            }
        }
        if !canonical_sha256(&self.artifact_after_hash) {
            return Err("derived contract artifact hash is invalid".to_string());
        }
        if !canonical_sha256(&self.oracle_code_hash) {
            return Err("derived contract oracle code hash is invalid".to_string());
        }
        if !self
            .compile_transport_nonce
            .strip_prefix(COMPILE_TRANSPORT_NONCE_PREFIX)
            .is_some_and(|nonce| {
                nonce.len() == 32
                    && nonce
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err("derived contract compile transport nonce is invalid".to_string());
        }
        Ok(())
    }
}

impl ComputeExpectedOutputContractV2 {
    pub fn contract_hash(&self) -> &str {
        &self.contract_hash
    }

    pub fn semantics(&self) -> &ComputeExpectedOutputSemantics {
        &self.semantics
    }

    pub fn binding(&self) -> &ComputeExpectedOutputContractBindingV2 {
        &self.binding
    }

    pub fn canonical_hash(&self) -> String {
        let material = serde_json::json!([
            self.schema_version,
            self.derivation_schema_version,
            self.semantics.semantics_hash,
            self.binding.project_id,
            self.binding.edit_id,
            self.binding.artifact_after_hash,
            self.binding.output_target_id,
            self.binding.oracle_code_hash,
            self.binding.compile_transport_nonce,
            self.binding.runtime_session_id,
        ]);
        domain_hash(CONTRACT_V2_HASH_DOMAIN, &material)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != COMPUTE_EXPECTED_OUTPUT_CONTRACT_V2_SCHEMA_VERSION {
            return Err("derived contract schema version mismatch".to_string());
        }
        if self.derivation_schema_version != COMPUTE_EXPECTED_OUTPUT_DERIVATION_SCHEMA_VERSION {
            return Err("derivation schema version mismatch".to_string());
        }
        self.semantics.validate()?;
        self.binding.validate()?;
        if self.binding.output_target_id != self.semantics.output_target_id {
            return Err("derived contract target mismatch".to_string());
        }
        if !canonical_sha256(&self.contract_hash) || self.contract_hash != self.canonical_hash() {
            return Err("derived contract hash mismatch".to_string());
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for ComputeExpectedOutputContractV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawComputeExpectedOutputContractV2::deserialize(deserializer)?;
        let contract = Self {
            schema_version: raw.schema_version,
            derivation_schema_version: raw.derivation_schema_version,
            semantics: raw.semantics,
            binding: raw.binding,
            contract_hash: raw.contract_hash,
        };
        contract.validate().map_err(D::Error::custom)?;
        Ok(contract)
    }
}

impl ComputeExpectedOutputSemantics {
    pub fn semantics_hash(&self) -> &str {
        &self.semantics_hash
    }

    pub fn output_target_id(&self) -> &str {
        &self.output_target_id
    }

    pub fn expected_evidence_hash(&self) -> &str {
        match self.comparison_mode.as_str() {
            "exact_bytes" => self
                .expected_raw_hash
                .as_deref()
                .expect("validated exact-byte semantics require expectedRawHash"),
            "numeric_tolerance" => self
                .expected_values_hash
                .as_deref()
                .expect("validated numeric semantics require expectedValuesHash"),
            _ => unreachable!("validated semantics use a known comparison mode"),
        }
    }

    pub fn derive_contract_v2(
        &self,
        binding: ComputeExpectedOutputContractBindingV2,
    ) -> Result<ComputeExpectedOutputContractV2, String> {
        self.validate()?;
        binding.validate()?;
        if binding.output_target_id != self.output_target_id {
            return Err("compute expected-output v2 target mismatch".to_string());
        }
        let mut contract = ComputeExpectedOutputContractV2 {
            schema_version: COMPUTE_EXPECTED_OUTPUT_CONTRACT_V2_SCHEMA_VERSION.to_string(),
            derivation_schema_version: COMPUTE_EXPECTED_OUTPUT_DERIVATION_SCHEMA_VERSION
                .to_string(),
            semantics: self.clone(),
            binding,
            contract_hash: String::new(),
        };
        contract.contract_hash = contract.canonical_hash();
        contract.validate()?;
        Ok(contract)
    }

    pub fn canonical_hash(&self) -> String {
        let shape = self.shape.iter().map(u64::to_string).collect::<Vec<_>>();
        let material = serde_json::json!([
            self.schema_version,
            self.comparison_mode,
            self.output_target_id,
            self.byte_offset.to_string(),
            self.byte_length.to_string(),
            self.dtype,
            shape,
            self.element_count.to_string(),
            self.byte_order,
            self.tolerance_decimal,
            self.expected_values_decimal,
            self.expected_values_hash,
            self.expected_raw_hash,
        ]);
        domain_hash(SEMANTICS_HASH_DOMAIN, &material)
    }

    fn from_map(mut fields: Map<String, Value>) -> Result<Self, String> {
        if fields.len() != SEMANTICS_FIELDS.len()
            || SEMANTICS_FIELDS
                .iter()
                .any(|field| !fields.contains_key(*field))
        {
            return Err("expected exact semantic-contract fields".to_string());
        }

        let semantics = Self {
            schema_version: required_string(&mut fields, "schemaVersion")?,
            comparison_mode: required_string(&mut fields, "comparisonMode")?,
            output_target_id: required_string(&mut fields, "outputTargetId")?,
            byte_offset: required_u64(&mut fields, "byteOffset")?,
            byte_length: required_u64(&mut fields, "byteLength")?,
            dtype: required_string(&mut fields, "dtype")?,
            shape: required_u64_array(&mut fields, "shape")?,
            element_count: required_u64(&mut fields, "elementCount")?,
            byte_order: required_string(&mut fields, "byteOrder")?,
            tolerance_decimal: required_string(&mut fields, "toleranceDecimal")?,
            expected_values_decimal: required_nullable_string_array(
                &mut fields,
                "expectedValuesDecimal",
            )?,
            expected_values_hash: required_nullable_string(&mut fields, "expectedValuesHash")?,
            expected_raw_hash: required_nullable_string(&mut fields, "expectedRawHash")?,
            semantics_hash: required_string(&mut fields, "semanticsHash")?,
        };
        semantics.validate()?;
        Ok(semantics)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION {
            return Err("schema version mismatch".to_string());
        }
        if !matches!(
            self.comparison_mode.as_str(),
            "exact_bytes" | "numeric_tolerance"
        ) {
            return Err("comparison mode is invalid".to_string());
        }
        if self.output_target_id.is_empty()
            || self.output_target_id.len() > MAX_OUTPUT_TARGET_CHARS
            || !self
                .output_target_id
                .bytes()
                .all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err("output target is invalid".to_string());
        }
        if self.byte_offset > MAX_SAFE_JSON_INTEGER
            || self.byte_length == 0
            || self.byte_length > MAX_SAFE_JSON_INTEGER
            || self.element_count == 0
            || self.element_count > MAX_SAFE_JSON_INTEGER
        {
            return Err("byte selection or element count is invalid".to_string());
        }
        if self.shape.len() > MAX_SHAPE_RANK
            || self
                .shape
                .iter()
                .any(|dimension| *dimension == 0 || *dimension > MAX_SAFE_JSON_INTEGER)
        {
            return Err("shape is invalid".to_string());
        }
        let shape_elements = self.shape.iter().try_fold(1_u64, |product, dimension| {
            product
                .checked_mul(*dimension)
                .filter(|value| *value <= MAX_SAFE_JSON_INTEGER)
        });
        if shape_elements != Some(self.element_count) {
            return Err("shape does not match element count".to_string());
        }
        let dtype_bytes = dtype_bytes(&self.dtype).ok_or_else(|| "dtype is invalid".to_string())?;
        if self
            .element_count
            .checked_mul(dtype_bytes)
            .filter(|value| *value <= MAX_SAFE_JSON_INTEGER)
            != Some(self.byte_length)
            || self.byte_offset % dtype_bytes != 0
            || self
                .byte_offset
                .checked_add(self.byte_length)
                .is_none_or(|end| end > MAX_SAFE_JSON_INTEGER)
        {
            return Err("byte selection does not match dtype and shape".to_string());
        }
        if !matches!(
            self.byte_order.as_str(),
            "little_endian" | "big_endian" | "not_applicable"
        ) || (dtype_bytes == 1 && self.byte_order != "not_applicable")
            || (dtype_bytes > 1 && self.byte_order == "not_applicable")
        {
            return Err("byte order does not match dtype width".to_string());
        }
        if !canonical_decimal(&self.tolerance_decimal) || self.tolerance_decimal.starts_with('-') {
            return Err("tolerance is invalid".to_string());
        }

        match self.comparison_mode.as_str() {
            "exact_bytes" => {
                if self.tolerance_decimal != "0"
                    || self.expected_values_decimal.is_some()
                    || self.expected_values_hash.is_some()
                    || self
                        .expected_raw_hash
                        .as_deref()
                        .is_none_or(|value| !canonical_sha256(value))
                {
                    return Err("exact-byte expectation fields are inconsistent".to_string());
                }
            }
            "numeric_tolerance" => {
                let values = self
                    .expected_values_decimal
                    .as_ref()
                    .ok_or_else(|| "numeric expectation fields are inconsistent".to_string())?;
                if values.is_empty()
                    || values.len() > MAX_EXPECTED_VALUES
                    || values.len() as u64 != self.element_count
                    || values
                        .iter()
                        .any(|value| !decimal_valid_for_dtype(value, &self.dtype))
                    || self.expected_raw_hash.is_some()
                    || self.expected_values_hash.as_deref().is_none_or(|hash| {
                        !canonical_sha256(hash) || hash != expected_values_hash(values)
                    })
                {
                    return Err("numeric expectation fields are inconsistent".to_string());
                }
            }
            _ => unreachable!("comparison mode checked above"),
        }
        if !canonical_sha256(&self.semantics_hash) || self.semantics_hash != self.canonical_hash() {
            return Err("semantics hash mismatch".to_string());
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for ComputeExpectedOutputSemantics {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct SemanticsVisitor;

        impl<'de> Visitor<'de> for SemanticsVisitor {
            type Value = ComputeExpectedOutputSemantics;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a canonical compute expected-output semantics object")
            }

            fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut fields = Map::new();
                while let Some((key, value)) = access.next_entry::<String, Value>()? {
                    if fields.insert(key.clone(), value).is_some() {
                        return Err(A::Error::custom(format!("duplicate field {key}")));
                    }
                }
                ComputeExpectedOutputSemantics::from_map(fields).map_err(A::Error::custom)
            }
        }

        deserializer.deserialize_map(SemanticsVisitor)
    }
}

fn take_required(fields: &mut Map<String, Value>, key: &str) -> Result<Value, String> {
    fields
        .remove(key)
        .ok_or_else(|| format!("missing field {key}"))
}

fn required_string(fields: &mut Map<String, Value>, key: &str) -> Result<String, String> {
    take_required(fields, key)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("field {key} must be a string"))
}

fn required_nullable_string(
    fields: &mut Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match take_required(fields, key)? {
        Value::Null => Ok(None),
        Value::String(value) => Ok(Some(value)),
        _ => Err(format!("field {key} must be a string or null")),
    }
}

fn required_u64(fields: &mut Map<String, Value>, key: &str) -> Result<u64, String> {
    take_required(fields, key)?
        .as_u64()
        .ok_or_else(|| format!("field {key} must be an unsigned integer"))
}

fn required_u64_array(fields: &mut Map<String, Value>, key: &str) -> Result<Vec<u64>, String> {
    let Value::Array(values) = take_required(fields, key)? else {
        return Err(format!("field {key} must be an array"));
    };
    values
        .into_iter()
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| format!("field {key} must contain unsigned integers"))
        })
        .collect()
}

fn required_nullable_string_array(
    fields: &mut Map<String, Value>,
    key: &str,
) -> Result<Option<Vec<String>>, String> {
    match take_required(fields, key)? {
        Value::Null => Ok(None),
        Value::Array(values) => values
            .into_iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("field {key} must contain strings"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        _ => Err(format!("field {key} must be an array or null")),
    }
}

fn dtype_bytes(dtype: &str) -> Option<u64> {
    match dtype {
        "u8" | "i8" => Some(1),
        "u16" | "i16" => Some(2),
        "u32" | "i32" | "f32" => Some(4),
        "u64" | "i64" | "f64" => Some(8),
        _ => None,
    }
}

fn canonical_decimal(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_DECIMAL_CHARS || !value.is_ascii() || value == "-0" {
        return false;
    }
    let unsigned = value.strip_prefix('-').unwrap_or(value);
    let (integer, fraction) = match unsigned.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (unsigned, None),
    };
    if integer.is_empty()
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
        || (integer.len() > 1 && integer.starts_with('0'))
    {
        return false;
    }
    fraction.is_none_or(|fraction| {
        !fraction.is_empty()
            && fraction.bytes().all(|byte| byte.is_ascii_digit())
            && !fraction.ends_with('0')
    })
}

fn decimal_valid_for_dtype(value: &str, dtype: &str) -> bool {
    if !canonical_decimal(value) {
        return false;
    }
    match dtype {
        "u8" => value.parse::<u8>().is_ok(),
        "i8" => value.parse::<i8>().is_ok(),
        "u16" => value.parse::<u16>().is_ok(),
        "i16" => value.parse::<i16>().is_ok(),
        "u32" => value.parse::<u32>().is_ok(),
        "i32" => value.parse::<i32>().is_ok(),
        "u64" => value.parse::<u64>().is_ok(),
        "i64" => value.parse::<i64>().is_ok(),
        "f32" => value.parse::<f64>().is_ok_and(|parsed| {
            let narrowed = parsed as f32;
            parsed.is_finite() && narrowed.is_finite() && (narrowed != 0.0 || parsed == 0.0)
        }),
        "f64" => value
            .parse::<f64>()
            .is_ok_and(|parsed| parsed.is_finite() && (parsed != 0.0 || value == "0")),
        _ => false,
    }
}

fn canonical_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn canonical_contract_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OUTPUT_TARGET_CHARS
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn expected_values_hash(values: &[String]) -> String {
    domain_hash(
        EXPECTED_VALUES_HASH_DOMAIN,
        &Value::Array(values.iter().cloned().map(Value::String).collect()),
    )
}

fn domain_hash(domain: &str, value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(value).expect("fixed semantic material must serialize"));
    format!("sha256:{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact_contract() -> Value {
        serde_json::json!({
            "schemaVersion": COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
            "comparisonMode": "exact_bytes",
            "outputTargetId": "output:tensor:0",
            "byteOffset": 64,
            "byteLength": 16,
            "dtype": "u32",
            "shape": [2, 2],
            "elementCount": 4,
            "byteOrder": "little_endian",
            "toleranceDecimal": "0",
            "expectedValuesDecimal": null,
            "expectedValuesHash": null,
            "expectedRawHash": format!("sha256:{}", "a".repeat(64)),
            "semanticsHash": "sha256:cd7074de01fc4bc0fb0eab922f457e4499c886128cadff30232b7e5f6df3bdde",
        })
    }

    fn numeric_contract() -> Value {
        serde_json::json!({
            "schemaVersion": COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
            "comparisonMode": "numeric_tolerance",
            "outputTargetId": "output:activation:final",
            "byteOffset": 0,
            "byteLength": 16,
            "dtype": "f32",
            "shape": [4],
            "elementCount": 4,
            "byteOrder": "little_endian",
            "toleranceDecimal": "0.001",
            "expectedValuesDecimal": ["0.125", "-3.5", "12", "0"],
            "expectedValuesHash": "sha256:e793fbfcf7ce664e5632eaeee3e79cfd1fde4ee4a9db0ff6556647076f036450",
            "expectedRawHash": null,
            "semanticsHash": "sha256:c35711fc5f51ee39096b85a00b41df7a83d07dac706fc132dfe93719fba58c32",
        })
    }

    fn contract_binding(output_target_id: &str) -> ComputeExpectedOutputContractBindingV2 {
        ComputeExpectedOutputContractBindingV2 {
            project_id: "project:generic".to_string(),
            edit_id: "source-edit:generic".to_string(),
            artifact_after_hash: format!("sha256:{}", "b".repeat(64)),
            output_target_id: output_target_id.to_string(),
            oracle_code_hash: format!("sha256:{}", "c".repeat(64)),
            compile_transport_nonce: "gpu-proof-transport-request:0123456789abcdef0123456789abcdef"
                .to_string(),
            runtime_session_id: "runtime-session:generic".to_string(),
        }
    }

    #[test]
    fn semantic_hashes_match_typescript_golden_vectors() {
        for (contract, expected_evidence_hash) in [
            (exact_contract(), format!("sha256:{}", "a".repeat(64))),
            (
                numeric_contract(),
                "sha256:e793fbfcf7ce664e5632eaeee3e79cfd1fde4ee4a9db0ff6556647076f036450"
                    .to_string(),
            ),
        ] {
            let parsed: ComputeExpectedOutputSemantics =
                serde_json::from_value(contract).expect("canonical semantic contract");
            assert_eq!(parsed.semantics_hash(), parsed.canonical_hash());
            assert_eq!(parsed.expected_evidence_hash(), expected_evidence_hash);
        }
    }

    #[test]
    fn semantic_contract_rejects_rehashed_invalid_meaning_and_duplicate_fields() {
        let mut invalid = numeric_contract();
        invalid["expectedValuesDecimal"][0] = Value::String("0.1250".to_string());
        assert!(serde_json::from_value::<ComputeExpectedOutputSemantics>(invalid).is_err());

        let duplicate = format!(
            "{{\"schemaVersion\":\"{}\",\"schemaVersion\":\"{}\"}}",
            COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
            COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
        );
        assert!(serde_json::from_str::<ComputeExpectedOutputSemantics>(&duplicate).is_err());
    }

    #[test]
    fn semantic_contract_accepts_scalars_and_rejects_selection_overflow() {
        let mut scalar = exact_contract();
        scalar["byteOffset"] = serde_json::json!(0);
        scalar["byteLength"] = serde_json::json!(4);
        scalar["shape"] = serde_json::json!([]);
        scalar["elementCount"] = serde_json::json!(1);
        let scalar_material = serde_json::json!([
            COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
            "exact_bytes",
            "output:tensor:0",
            "0",
            "4",
            "u32",
            Vec::<String>::new(),
            "1",
            "little_endian",
            "0",
            Value::Null,
            Value::Null,
            format!("sha256:{}", "a".repeat(64)),
        ]);
        scalar["semanticsHash"] =
            Value::String(domain_hash(SEMANTICS_HASH_DOMAIN, &scalar_material));
        assert!(serde_json::from_value::<ComputeExpectedOutputSemantics>(scalar).is_ok());

        let mut overflow = exact_contract();
        overflow["byteOffset"] = serde_json::json!(MAX_SAFE_JSON_INTEGER - 15);
        assert!(serde_json::from_value::<ComputeExpectedOutputSemantics>(overflow).is_err());
    }

    #[test]
    fn f32_decimal_validation_uses_binary64_then_binary32_narrowing() {
        let double_rounds_to_zero =
            "0.00000000000000000000000000000000000000000000070064923216240857435571027827709373529053130706403438956761";
        assert_ne!(double_rounds_to_zero.parse::<f32>().unwrap(), 0.0);
        assert_eq!(double_rounds_to_zero.parse::<f64>().unwrap() as f32, 0.0);
        assert!(!decimal_valid_for_dtype(double_rounds_to_zero, "f32"));

        assert!(decimal_valid_for_dtype(
            "0.000000000000000000000000000000000000000000001",
            "f32",
        ));
        assert!(decimal_valid_for_dtype(
            "340282346638528859811704183484516925440",
            "f32",
        ));
        assert!(!decimal_valid_for_dtype(
            "340282356779733661637539395458142568448",
            "f32",
        ));
    }

    #[test]
    fn derived_contract_hashes_match_typescript_golden_vectors() {
        for (semantics_value, expected_hash) in [
            (
                exact_contract(),
                "sha256:25324a3665869f50e1163acbaf601322fb6fa63c1609876180f99a8bb837d748",
            ),
            (
                numeric_contract(),
                "sha256:4e164b0c64e6235260a70ebd0fb45be6a9ea1cb19c5c06a6c3c699851be34547",
            ),
        ] {
            let semantics: ComputeExpectedOutputSemantics =
                serde_json::from_value(semantics_value).expect("canonical semantics");
            let derived = semantics
                .derive_contract_v2(contract_binding(semantics.output_target_id()))
                .expect("derived contract");
            assert_eq!(derived.contract_hash(), expected_hash);

            let serialized = serde_json::to_value(&derived).expect("serialized derived contract");
            let reparsed: ComputeExpectedOutputContractV2 =
                serde_json::from_value(serialized).expect("validated derived contract");
            assert_eq!(reparsed, derived);
        }
    }

    #[test]
    fn derived_contract_preserves_scalar_selection_and_rejects_partial_binding() {
        let mut scalar = exact_contract();
        scalar["byteOffset"] = serde_json::json!(128);
        scalar["byteLength"] = serde_json::json!(4);
        scalar["shape"] = serde_json::json!([]);
        scalar["elementCount"] = serde_json::json!(1);
        let scalar_material = serde_json::json!([
            COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
            "exact_bytes",
            "output:tensor:0",
            "128",
            "4",
            "u32",
            Vec::<String>::new(),
            "1",
            "little_endian",
            "0",
            Value::Null,
            Value::Null,
            format!("sha256:{}", "a".repeat(64)),
        ]);
        scalar["semanticsHash"] =
            Value::String(domain_hash(SEMANTICS_HASH_DOMAIN, &scalar_material));
        let semantics: ComputeExpectedOutputSemantics =
            serde_json::from_value(scalar).expect("scalar semantics");
        let derived = semantics
            .derive_contract_v2(contract_binding(semantics.output_target_id()))
            .expect("scalar derived contract");
        assert!(derived.semantics().shape.is_empty());
        assert_eq!(derived.semantics().byte_offset, 128);
        assert_eq!(derived.semantics().byte_length, 4);

        let mut invalid_binding =
            serde_json::to_value(contract_binding(semantics.output_target_id()))
                .expect("binding value");
        invalid_binding
            .as_object_mut()
            .expect("binding object")
            .remove("compileTransportNonce");
        assert!(
            serde_json::from_value::<ComputeExpectedOutputContractBindingV2>(invalid_binding)
                .is_err()
        );
    }

    #[test]
    fn derived_contract_rejects_aliases_and_rehashed_cross_target_substitution() {
        let semantics: ComputeExpectedOutputSemantics =
            serde_json::from_value(exact_contract()).expect("canonical semantics");
        let derived = semantics
            .derive_contract_v2(contract_binding(semantics.output_target_id()))
            .expect("derived contract");
        let mut aliased = serde_json::to_value(&derived).expect("derived contract value");
        aliased["schema_version"] = aliased["schemaVersion"].clone();
        assert!(serde_json::from_value::<ComputeExpectedOutputContractV2>(aliased).is_err());

        let mut substituted = serde_json::to_value(&derived).expect("derived contract value");
        substituted["binding"]["outputTargetId"] = serde_json::json!("output:other");
        let mut substituted_contract: ComputeExpectedOutputContractV2 = derived.clone();
        substituted_contract.binding.output_target_id = "output:other".to_string();
        substituted["contractHash"] = serde_json::json!(substituted_contract.canonical_hash());
        assert!(serde_json::from_value::<ComputeExpectedOutputContractV2>(substituted).is_err());
    }
}
