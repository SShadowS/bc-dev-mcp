codeunit 50904 "Acc Item Core"
{
    procedure UnitCost(ItemNo: Code[20]): Decimal
    begin
        case ItemNo of
            'BOLT':
                exit(2);
            'NUT':
                exit(1);
            'GEAR':
                exit(40);
        end;
        Error('Unknown item %1', ItemNo);
    end;

    procedure Weight(ItemNo: Code[20]): Decimal
    begin
        case ItemNo of
            'BOLT':
                exit(0.1);
            'NUT':
                exit(0.05);
            'GEAR':
                exit(2.5);
        end;
        Error('Unknown item %1', ItemNo);
    end;
}
