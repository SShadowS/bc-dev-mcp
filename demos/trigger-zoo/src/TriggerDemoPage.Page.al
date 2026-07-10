page 50152 "Trigger Demo Page"
{
    // Demo page for bc-dev-mcp's debugger object-type coverage walkthrough
    // (demos/OBJECT-TYPES.md). OnOpenPage assigns a local then deliberately
    // errors, so a break-on-error debug session pauses inside a PAGE trigger
    // (objectType 8) with CurrPage in scope. Triggered headless from a test
    // codeunit via TestPage.OpenView().
    PageType = Card;
    SourceTable = "Trigger Demo";
    ApplicationArea = All;
    UsageCategory = Administration;

    layout
    {
        area(Content)
        {
            group(General)
            {
                field(Id; Rec.Id)
                {
                    ApplicationArea = All;
                }
                field(Description; Rec.Description)
                {
                    ApplicationArea = All;
                }
            }
        }
    }

    trigger OnOpenPage()
    var
        PageLocalText: Text[50];
    begin
        PageLocalText := 'page trigger zoo';
        Error('page OnOpenPage break');
    end;
}
