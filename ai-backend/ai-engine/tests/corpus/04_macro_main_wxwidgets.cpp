// Phase 7 corpus — wxWidgets IMPLEMENT_APP macro hides main()
// Mitigation 2A: AI should detect the macro and set
// confidence.runner_synthesis=low. confidence.notes must mention
// the macro. Worker then refuses to compile and surfaces the BYOR
// error card.
#include <wx/wx.h>

class MyApp : public wxApp {
public:
    virtual bool OnInit() override {
        wxFrame* frame = new wxFrame(nullptr, wxID_ANY, "wxApp HMR Test");
        frame->SetSize(800, 600);
        frame->Show(true);
        return true;
    }
};

IMPLEMENT_APP(MyApp)
