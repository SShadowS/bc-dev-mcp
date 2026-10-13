codeunit 50905 "Acc Item Rules"
{
    var
        Core: Codeunit "Acc Item Core";
        Validation: Codeunit "Acc Item Validation";
        Math: Codeunit "Acc Math";

    procedure SalesPrice(ItemNo: Code[20]): Decimal
    begin
        Validation.ValidateItemNo(ItemNo);
        exit(Math.Round2(Core.UnitCost(ItemNo) * (1 + MarkupPct(ItemNo) / 100)));
    end;

    procedure MarkupPct(ItemNo: Code[20]): Decimal
    begin
        if Core.UnitCost(ItemNo) >= 10 then
            exit(25);
        exit(50);
    end;
}
