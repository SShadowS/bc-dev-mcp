codeunit 50990 "Risk Ops"
{
    procedure PostOrder(OrderNo: Code[20])
    var
        Order: Record "Risk Order";
    begin
        Order.Get(OrderNo);
        Order.Amount := 0;
        Order.Modify();
        Commit();
    end;

    procedure ResetAmount(OrderNo: Code[20])
    var
        Order: Record "Risk Order";
    begin
        Order.Get(OrderNo);
        Order.Amount := 0;
        Order.Modify();
    end;

    procedure CheckAmount(Amount: Decimal)
    begin
        if Amount < 0 then
            Error('Negative');
    end;

    procedure Double(Amount: Decimal): Decimal
    begin
        exit(Amount * 2);
    end;
}
