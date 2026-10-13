codeunit 50173 "RW Mixed Writer"
{
    procedure Both()
    var
        Ledger: Record "RW Ledger";
        Other: Record "RW Other";
    begin
        Ledger.Insert();
        Other.Insert();
    end;

    procedure OtherOnly()
    var
        Other: Record "RW Other";
    begin
        Other.DeleteAll();
    end;

    procedure DynPlusOther(RecRef: RecordRef)
    var
        Other: Record "RW Other";
    begin
        RecRef.Insert();
        Other.Delete();
    end;
}
