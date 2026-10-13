codeunit 50917 "Acc Shipping Core"
{
    var
        Math: Codeunit "Acc Math";

    procedure Freight(Weight: Decimal; Express: Boolean): Decimal
    begin
        if Express then
            exit(Math.Round2(15 + Weight * 3));
        exit(Math.Round2(5 + Weight));
    end;
}
