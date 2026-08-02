from shadow.post_selection_mutation import summarize_post_selection_mutation


def test_post_selection_mutation_never_retains_source_and_scores_removed_abstraction():
    mutation = summarize_post_selection_mutation(
        selected_branch_id="br_run_B", observation_window="24h",
        files=[{"path": "runtime.py", "generated_content": "class Runtime: pass", "observed_content": ""}],
        abstraction_removed=True, runtime_changed_by_user=True,
        now=100,
    )

    record = mutation.to_dict()
    assert record["retention_score"] == 0.0
    assert record["deleted_generated_blocks"] == 1
    assert "class Runtime" not in str(record)
    assert "main abstraction was removed" in record["mutation_summary"]


def test_post_selection_mutation_scores_small_edits_as_retained():
    mutation = summarize_post_selection_mutation(
        selected_branch_id="br_run_A", observation_window="1h",
        files=[{"path": "app.py", "generated_content": "print('hello')\n", "observed_content": "print('hello world')\n"}],
        now=100,
    )

    assert mutation.retention_score == 0.7
