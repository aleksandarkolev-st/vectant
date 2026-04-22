# counter_swing — phase 2b enriched-tier fixture

Minimal Swing app with explicit `javax.accessibility` wiring. Used by the
a11y-bridge provider path of the enriched tier (ultraplan §Enriched tools,
`PHASE_2B_ENRICHMENT` sub-phase).

## What it is

- One window with three semantic widgets: a counter display, Increment/Decrement buttons, and a Step spinner.
- Every widget sets `accessibleName` + `accessibleDescription` so the a11y tree has stable lookup keys.
- `updateCounter` fires `AccessibleContext.ACCESSIBLE_VALUE_PROPERTY` property-change events so a11y consumers observe state transitions.

## Build + run standalone

```bash
./build.sh run
```

`javac CounterSwing.java` + `java CounterSwing` works too; the script just wraps both + sets a11y JVM flags.

## What it exercises

| Entity | AccessibleRole | Covered scenarios |
|---|---|---|
| `Counter` | `LABEL` | enriched-tier label read-back, `synthi_get_labels` |
| `Increment` | `PUSH_BUTTON` | `synthi_act({action:"press"})`, `synthi_click_text({text:"Increment"})` |
| `Decrement` | `PUSH_BUTTON` | Same as above; also ambiguity test when both buttons match a partial name-contains query |
| `Step` | `SPINNER` | `synthi_fill_form`, input-during-compile structural-change gate |

## Why Swing

- `javax.accessibility` is a read-only introspection API — no new injection surface added to the worker.
- JNI bridging is bounded: the worker already embeds a JVM for Java-runtime fixtures.
- If Lane A (a11y bridge) fails, Lane B (`synthi-probe` cooperative library) still ships for SDL2 — they don't depend on each other.

See the phase 2b plan discussion in the branch history for the full design.
