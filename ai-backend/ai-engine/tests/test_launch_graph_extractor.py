from agents.launch_graph_extractor import launch_graph_as_dicts


def test_extracts_synthi_launch_boundary():
    graph = launch_graph_as_dicts(
        {
            "core.cpp": """
void step() {
  synthi_gpu_launch(gpu, "vec_add", (n + 255) / 256, 256, 0, stream,
                    { &a, &b, &c, &n });
}
""",
            "device.cu": "__global__ void vec_add(const float*, const float*, float*, int) {}",
        }
    )
    assert len(graph) == 1
    assert graph[0]["kernel"] == "vec_add"
    assert graph[0]["form"] == "synthi_gpu_launch"
    assert graph[0]["grid"] == "(n + 255) / 256"
    assert graph[0]["block"] == "256"
    assert graph[0]["args"] == ["a", "b", "c", "n"]


def test_extracts_raw_launch_for_pre_rewrite_source():
    graph = launch_graph_as_dicts({"core.cpp": "void step(){ vec_add<<<grid, block, 0, stream>>>(a, b, c, n); }"})
    assert len(graph) == 1
    assert graph[0]["kernel"] == "vec_add"
    assert graph[0]["form"] == "raw_triple_chevron"
    assert graph[0]["stream"] == "stream"


def test_extracts_runtime_kernel_object_launch():
    graph = launch_graph_as_dicts(
        {
            "render_pass.cpp": """
void configure() {
  kernels[RenderPass::MAIN]->set_kernel_function_name("shade_pixels");
}
void launch() {
  kernels[RenderPass::MAIN]->launch_asynchronous(
      BlockWidth, BlockHeight, width, height, launch_args, stream);
}
"""
        }
    )

    assert len(graph) == 1
    assert graph[0]["kernel"] == "shade_pixels"
    assert graph[0]["form"] == "runtime_kernel_object"
    assert graph[0]["block"] == "BlockWidth, BlockHeight, 1"
    assert graph[0]["grid"] == "width, height, 1"
    assert graph[0]["stream"] == "stream"
    assert graph[0]["args"] == ["launch_args"]


def test_ignores_commented_launch_forms():
    graph = launch_graph_as_dicts(
        {
            "core.cpp": r'''
void configure() {
  // ignored_raw<<<grid, block>>>(args);
  /* synthi_gpu_launch(gpu, "ignored_boundary", 1, 1, 0, stream, { &args }); */
  /*
  kernels.set_kernel_function_name("ignored_object");
  kernels.launch_asynchronous(1, 1, 1, 1, dummy_args, stream);
  */
  kernels.set_kernel_function_name("kept_object");
  kernels.launch_asynchronous(8, 8, width, height, launch_args, stream);
}
'''
        }
    )

    assert [item["kernel"] for item in graph] == ["kept_object"]
