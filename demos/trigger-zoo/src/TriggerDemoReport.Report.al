report 50151 "Trigger Demo Report"
{
    // Demo report for bc-dev-mcp's debugger object-type coverage walkthrough
    // (demos/OBJECT-TYPES.md). OnPreReport assigns two locals then deliberately
    // errors, so a break-on-error debug session pauses inside a REPORT trigger
    // (objectType 3) before the (empty, filtered-to-nothing) dataset ever runs.
    // ProcessingOnly + UseRequestPage = false so it runs headless from a test
    // codeunit with no request page / UI involved.
    ProcessingOnly = true;
    UseRequestPage = false;
    UsageCategory = ReportsAndAnalysis;
    ApplicationArea = All;

    dataset
    {
        dataitem(TriggerDemo; "Trigger Demo")
        {
            DataItemTableView = sorting(Id) where(Id = const(0));
        }
    }

    trigger OnPreReport()
    var
        ReportLocalText: Text[50];
        ReportLocalInt: Integer;
    begin
        ReportLocalText := 'report trigger zoo';
        ReportLocalInt := 42;
        Error('report OnPreReport break');
    end;
}
