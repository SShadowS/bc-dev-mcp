codeunit 50910 "Acc Discount Core"
{
    procedure CustomerDiscountPct(Rating: Integer): Decimal
    begin
        case Rating of
            1:
                exit(15);
            2:
                exit(10);
            3:
                exit(5);
        end;
        exit(0);
    end;
}
