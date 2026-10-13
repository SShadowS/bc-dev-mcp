codeunit 50907 "Acc Price Core"
{
    var
        Math: Codeunit "Acc Math";

    procedure LineAmount(Quantity: Decimal; UnitPrice: Decimal): Decimal
    begin
        exit(Math.Round2(Quantity * UnitPrice));
    end;
}
