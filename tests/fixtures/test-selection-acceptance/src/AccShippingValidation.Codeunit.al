codeunit 50919 "Acc Shipping Validation"
{
    procedure ValidateWeight(Weight: Decimal)
    begin
        if Weight < 0 then
            Error('Weight must not be negative');
    end;
}
