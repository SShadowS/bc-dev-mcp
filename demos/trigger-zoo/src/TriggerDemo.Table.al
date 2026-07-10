table 50150 "Trigger Demo"
{
    // Demo table for bc-dev-mcp's debugger object-type coverage walkthrough
    // (demos/OBJECT-TYPES.md). OnInsert assigns two locals then deliberately
    // errors, so a break-on-error debug session pauses inside a TABLE trigger
    // (objectType 1) instead of a codeunit method (objectType 5) — the point of
    // comparison for this demo.
    DataClassification = CustomerContent;

    fields
    {
        field(1; Id; Integer)
        {
            DataClassification = CustomerContent;
        }
        field(2; Description; Text[50])
        {
            DataClassification = CustomerContent;
        }
    }

    keys
    {
        key(PK; Id)
        {
            Clustered = true;
        }
    }

    trigger OnInsert()
    var
        TableLocalText: Text[50];
        TableLocalInt: Integer;
    begin
        TableLocalText := 'table trigger zoo';
        TableLocalInt := Id;
        Error('table OnInsert break');
    end;
}
