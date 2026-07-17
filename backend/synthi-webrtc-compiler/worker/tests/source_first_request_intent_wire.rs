use serde_json::json;
use worker::infra::messages::CompileRequest;

fn base_request() -> serde_json::Value {
    json!({
        "language": "cpp",
        "filename": "main.cpp",
        "source": "int main(){return 0;}"
    })
}

#[test]
fn forwards_source_first_request_intent_exactly() {
    let expected = json!({
        "schemaVersion": "synthi.gpu_hmr.source_first_request_intent.v1",
        "proofAuthority": "source_first_request_intent_only_not_runtime_proof",
        "acceptedForGpuHmr": false,
        "gpuHmrSuccess": false,
        "canSatisfyRuntimeProof": false,
        "canSatisfyDispatchProof": false,
        "intentHash": "sha256:0123456789abcdef"
    });
    let mut raw = base_request();
    raw.as_object_mut()
        .expect("object")
        .insert("source_first_request_intent".to_string(), expected.clone());

    let request: CompileRequest = serde_json::from_value(raw).expect("compile request");

    assert_eq!(
        request.source_first_request_intent.as_ref(),
        Some(&expected)
    );
}

#[test]
fn omits_source_first_request_intent_by_default() {
    let request: CompileRequest = serde_json::from_value(base_request()).expect("compile request");

    assert!(request.source_first_request_intent.is_none());
}

#[test]
fn rejects_non_object_source_first_request_intent() {
    for malformed in [json!(null), json!(true), json!("intent"), json!([])] {
        let mut raw = base_request();
        raw.as_object_mut()
            .expect("object")
            .insert("source_first_request_intent".to_string(), malformed);

        let result = serde_json::from_value::<CompileRequest>(raw);

        assert!(
            result.is_err(),
            "non-object request intent must be rejected"
        );
    }
}
