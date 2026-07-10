codeunit 50153 "Trigger Zoo Tests"
{
    // Test harness for bc-dev-mcp's debugger object-type coverage walkthrough
    // (demos/OBJECT-TYPES.md). Each [Test] method fires one non-codeunit
    // object's trigger, which then Errors — break-on-error pauses the debugger
    // inside that trigger, one test method at a time.
    Subtype = Test;

    [Test]
    procedure TableTrigger()
    var
        TriggerDemo: Record "Trigger Demo";
    begin
        // Explicit RunTrigger = true so OnInsert actually fires.
        TriggerDemo.Id := 1;
        TriggerDemo.Description := 'table trigger test';
        TriggerDemo.Insert(true);
    end;

    [Test]
    procedure ReportTrigger()
    begin
        Report.Run(Report::"Trigger Demo Report");
    end;

    [Test]
    procedure PageTrigger()
    var
        TriggerDemoPage: TestPage "Trigger Demo Page";
    begin
        TriggerDemoPage.OpenView();
    end;
}
