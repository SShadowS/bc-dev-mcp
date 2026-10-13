codeunit 50906 "Acc Item Validation"
{
    procedure ValidateItemNo(ItemNo: Code[20])
    begin
        if ItemNo = '' then
            Error('Item number must not be blank');
    end;
}
