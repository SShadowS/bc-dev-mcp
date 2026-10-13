codeunit 50990 "Asp Work"
{
    procedure Post()
    begin
        Entry.Insert();
        Commit();
    end;

    procedure Validate(Amount: Decimal)
    begin
        if Amount < 0 then
            Error('Negative amount');
    end;

    procedure Pure(Amount: Decimal): Decimal
    begin
        exit(Amount * 2);
    end;

    procedure Ask(): Boolean
    begin
        exit(Confirm('Sure?'));
    end;

    procedure Overloaded(Amount: Decimal)
    begin
        Commit();
    end;

    procedure Overloaded(Name: Text)
    begin
    end;

    procedure Driver(Amount: Decimal)
    begin
        Validate(Amount);
        Post();
    end;

    var
        Entry: Record "Asp Entry";
}
