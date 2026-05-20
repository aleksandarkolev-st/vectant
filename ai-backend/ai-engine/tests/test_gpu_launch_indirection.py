from agents.gpu_launch_indirection import build_launch_indirection_report


def test_launch_indirection_report_accepts_public_wrapper():
    report = build_launch_indirection_report(
        generated_files={
            ".synthi/generated/gpu/core.cpp": (
                'void step(){ synthi_gpu_launch(gpu, "flow", 1, 256, 0, stream, {&x}); }'
            ),
            ".synthi/generated/gpu/device.hip": '__global__ void flow(float* x) {}',
        },
        verification={"ok": True, "violations": []},
    )

    assert report["status"] == "pass"
    assert report["generatedLaunchSitesUseIndirection"] is True
    assert report["loaderOwnsSymbolLookup"] is True
    assert report["staleLaunchPointerChecks"]["status"] == "pass"
    assert (
        report["staleLaunchPointerChecks"]["failureReasonCode"]
        == "reload_failed.stale_launch_pointer"
    )


def test_launch_indirection_report_rejects_raw_runtime_bypass():
    report = build_launch_indirection_report(
        generated_files={
            "core.cpp": (
                "void step(){ auto t = synthi_gpu_launch_table(); "
                'synthi_gpu_launch_raw_checked(gpu, "flow", 0, 0, 0, 0, 0, 0, 0, 0, t.generation); }'
            ),
        },
        verification={"ok": False, "violations": [{"rule": "launch_indirection_bypassed"}]},
    )

    assert report["status"] == "fail"
    assert report["stalePointerRisk"] == "detected"
    assert report["directLaunchBypassCount"] >= 1
    assert "launch_indirection_bypassed" in report["reasonCodes"]
    assert report["staleLaunchPointerChecks"]["status"] == "fail"


def test_launch_indirection_report_rejects_vendor_symbol_lookup_in_generated_host():
    report = build_launch_indirection_report(
        generated_files={
            "host_runner.cpp": (
                "void* f = nullptr; "
                'hipModuleGetFunction(reinterpret_cast<hipFunction_t*>(&f), module, "flow");'
            ),
        }
    )

    assert report["status"] == "fail"
    assert report["loaderOwnsSymbolLookup"] is False
    assert "loader_symbol_lookup_bypassed" in report["reasonCodes"]
