codeunit 50912 "Acc Discount Validation"
{
    procedure ValidatePct(Pct: Decimal)
    begin
        if (Pct < 0) or (Pct > 100) then
            Error('Discount %1 is out of range', Pct);
    end;
}
