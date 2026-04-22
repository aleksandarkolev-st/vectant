// Phase 2b enriched-tier fixture — a minimal Swing counter app with
// explicit a11y wiring so the eventual a11y-bridge provider can walk
// the accessible tree and resolve entities by role + name.
//
// Builds standalone:
//
//   javac CounterSwing.java
//   java CounterSwing
//
// or with the provided build.sh. No external Maven/Gradle deps —
// Swing + javax.accessibility ship with the JRE.
//
// Entities exercised:
//   - JButton "Increment"   — AccessibleRole.PUSH_BUTTON
//   - JButton "Decrement"   — AccessibleRole.PUSH_BUTTON
//   - JLabel "Counter"      — AccessibleRole.LABEL
//   - JSpinner "Step"       — AccessibleRole.SPINNER
//
// Every widget carries a stable accessibleName so the a11y bridge can
// look them up deterministically; input-during-compile scenarios feed
// into the spinner to exercise the structural-change pHash gate.

import javax.accessibility.Accessible;
import javax.accessibility.AccessibleContext;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JSpinner;
import javax.swing.SpinnerNumberModel;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import java.awt.BorderLayout;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;

public final class CounterSwing {

    private int counter = 0;
    private int step = 1;
    private JLabel counterLabel;

    public static void main(String[] args) {
        // Force L&F that exposes a11y tree; Nimbus/Metal both work on
        // OpenJDK; the fixture doesn't depend on a specific choice.
        System.setProperty("swing.aatext", "true");
        SwingUtilities.invokeLater(() -> new CounterSwing().buildAndShow());
    }

    private void buildAndShow() {
        JFrame frame = new JFrame("CounterSwing");
        frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        frame.setPreferredSize(new Dimension(480, 240));

        JPanel center = new JPanel(new BorderLayout());
        counterLabel = new JLabel(String.valueOf(counter), SwingConstants.CENTER);
        counterLabel.setFont(counterLabel.getFont().deriveFont(Font.BOLD, 48f));
        setAccessible(counterLabel, "Counter", "Current counter value");
        center.add(counterLabel, BorderLayout.CENTER);

        JPanel controls = new JPanel(new FlowLayout(FlowLayout.CENTER, 16, 12));

        JButton inc = new JButton("Increment");
        inc.addActionListener(e -> updateCounter(step));
        setAccessible(inc, "Increment", "Increase the counter by the current step");

        JButton dec = new JButton("Decrement");
        dec.addActionListener(e -> updateCounter(-step));
        setAccessible(dec, "Decrement", "Decrease the counter by the current step");

        SpinnerNumberModel model = new SpinnerNumberModel(1, -100, 100, 1);
        JSpinner stepSpinner = new JSpinner(model);
        stepSpinner.addChangeListener(e -> step = (Integer) stepSpinner.getValue());
        setAccessible(stepSpinner, "Step", "Amount added or subtracted per click");

        controls.add(dec);
        controls.add(stepSpinner);
        controls.add(inc);

        frame.add(center, BorderLayout.CENTER);
        frame.add(controls, BorderLayout.SOUTH);
        frame.pack();
        frame.setLocationRelativeTo(null);
        frame.setVisible(true);
    }

    private void updateCounter(int delta) {
        counter += delta;
        counterLabel.setText(String.valueOf(counter));
        // Mirror the HMR state-report pattern so a11y consumers see the
        // change through the a11y event bus.
        AccessibleContext ctx = counterLabel.getAccessibleContext();
        if (ctx != null) {
            ctx.firePropertyChange(
                AccessibleContext.ACCESSIBLE_VALUE_PROPERTY,
                null,
                counter
            );
        }
    }

    private static void setAccessible(Accessible a, String name, String desc) {
        AccessibleContext ctx = a.getAccessibleContext();
        if (ctx != null) {
            ctx.setAccessibleName(name);
            ctx.setAccessibleDescription(desc);
        }
    }
}
