// Phase 7 corpus — Qt with Q_OBJECT (multi-step build — rejects)
// Mitigation 3: Qt requires MOC preprocessing before compile. V1
// does not execute multi-step builds, so this project MUST be
// REJECTED cleanly with the Phase 5.3 error card. Expected:
// manifest.build_steps is non-empty OR confidence.runner_synthesis
// is low with notes mentioning "moc" / "Q_OBJECT".
#include <QApplication>
#include <QMainWindow>
#include <QPushButton>
#include <QObject>

class MyWindow : public QMainWindow {
    Q_OBJECT

public:
    MyWindow(QWidget* parent = nullptr) : QMainWindow(parent) {
        resize(800, 600);
        setWindowTitle("Qt HMR Test");

        QPushButton* btn = new QPushButton("Click me", this);
        btn->setGeometry(50, 50, 200, 60);
        connect(btn, &QPushButton::clicked, this, &MyWindow::onClicked);
    }

public slots:
    void onClicked() {
        qDebug("Button clicked");
    }
};

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    MyWindow w;
    w.show();
    return app.exec();
}

#include "main.moc"
