codeunit 50983 "Sel Express Rate" implements "Sel Shipping Rate"
{
    procedure Rate(Weight: Decimal): Decimal
    begin
        exit(25 + Weight * 1.5);
    end;
}
