codeunit 50171 "RW Ledger Writer"
{
    procedure Post(NewCode: Code[20])
    var
        Ledger: Record "RW Ledger";
    begin
        Ledger.Code := NewCode;
        Ledger.Insert();
    end;

    procedure Adjust(NewCode: Code[20])
    var
        Ledger: Record "RW Ledger";
    begin
        if Ledger.Get(NewCode) then begin
            Ledger.Amount := 1;
            Ledger.Modify();
        end;
    end;

    procedure Purge()
    var
        Ledger: Record "RW Ledger";
    begin
        Ledger.DeleteAll();
    end;

    procedure Rekey(OldCode: Code[20]; NewCode: Code[20])
    var
        Ledger: Record "RW Ledger";
    begin
        if Ledger.Get(OldCode) then
            Ledger.Rename(NewCode);
    end;

    procedure ScratchOnly()
    var
        Scratch: Record "RW Ledger" temporary;
    begin
        Scratch.Code := 'X';
        Scratch.Insert();
    end;

    procedure ReadOnly(): Integer
    var
        Ledger: Record "RW Ledger";
    begin
        exit(Ledger.Count());
    end;

    procedure PostViaHelper(NewCode: Code[20])
    begin
        Post(NewCode);
    end;

    procedure DynamicWrite(RecRef: RecordRef)
    begin
        RecRef.Insert();
    end;
}
