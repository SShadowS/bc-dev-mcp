codeunit 50909 "Acc Price Validation"
{
    procedure ValidateQuantity(Quantity: Decimal)
    begin
        if Quantity <= 0 then
            Error('Quantity must be positive');
    end;
}
