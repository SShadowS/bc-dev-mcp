codeunit 50190 "RW Live Writer"
{
    // Live E2E for bcdev_record_writes_*: RunAll exercises Insert, Modify, a RecordRef Insert and an
    // unrelated-table Insert; NeverRun holds a Delete that the workload deliberately never calls.

    procedure InsertRow(Id: Integer)
    var
        Target: Record "RW Live Target";
    begin
        Target.Id := Id;
        Target.Note := 'ins';
        Target.Insert();
    end;

    procedure ModifyRow(Id: Integer)
    var
        Target: Record "RW Live Target";
    begin
        Target.Get(Id);
        Target.Note := 'mod';
        Target.Modify();
    end;

    procedure NeverRun(Id: Integer)
    var
        Target: Record "RW Live Target";
    begin
        Target.Get(Id);
        Target.Delete();
    end;

    procedure RecRefInsert(Id: Integer)
    var
        RecRef: RecordRef;
        FRef: FieldRef;
    begin
        RecRef.Open(Database::"RW Live Target");
        FRef := RecRef.Field(1);
        FRef.Value := Id;
        RecRef.Insert();
    end;

    procedure WriteOther(Id: Integer)
    var
        Other: Record "RW Live Other";
    begin
        Other.Id := Id;
        Other.Insert();
    end;

    procedure Busy()
    var
        i: Integer;
        Txt: Text;
    begin
        for i := 1 to 400000 do
            Txt := Format(i) + 'x';
    end;

    procedure RunAll(Id: Integer)
    begin
        InsertRow(Id);
        ModifyRow(Id);
        RecRefInsert(Id + 1000);
        WriteOther(Id);
        Busy();
    end;
}
