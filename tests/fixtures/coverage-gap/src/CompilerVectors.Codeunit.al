codeunit 50990 "Compiler Method Vectors"
{
    [TryFunction]
    procedure TryDivide(Numerator: Decimal; Denominator: Decimal)
    var
        Result: Decimal;
    begin
        Result := Numerator / Denominator;
    end;

    procedure "Größe"()
    begin
    end;
}
